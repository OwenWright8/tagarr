// The sync engine. Autotagarr keeps its own record of who each item belongs to
// (the `assignments` table) and makes Jellyfin's tags match it:
//
//   1. Refresh the library from Jellyfin.
//   2. Adopt people's tags that are already on items (so an existing setup is
//      picked up as it is, and a tag added in Jellyfin's own editor sticks).
//   3. Read Seerr's requests and assign each requested item to its requester
//      once it shows up in Jellyfin. Each request is applied once, so taking a
//      tag off later is respected.
//   4. Optionally give unrequested items to chosen people after a grace period.
//   5. Suggest tags from watch history.
//   6. Write any missing tags to Jellyfin (this also repairs tags lost to a
//      metadata refresh), and copy them to seasons/episodes if enabled.
//
// Removing a tag in the app takes it off in Jellyfin straight away, so the
// two only ever drift through outside changes, which steps 2 and 6 settle.
import {
  type DB,
  type ItemRow,
  type Person,
  type Settings,
  getSettings,
  listPeople,
  logActivity,
  tx,
} from "./db.ts";
import { Jellyfin, hasTag } from "./jellyfin.ts";
import { REQUEST_DECLINED, Seerr, seerrUserName } from "./seerr.ts";

export interface SyncStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  error: string | null;
  reason: string | null;
  stats: SyncStats | null;
  nextAt: number | null;
}

export interface SyncStats {
  items: number;
  tagged: number;
  adopted: number;
  fromRequests: number;
  fromRule: number;
  pendingRequests: number;
  suggestions: number;
  errors: number;
}

export class Engine {
  db: DB;
  status: SyncStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    ok: null,
    error: null,
    reason: null,
    stats: null,
    nextAt: null,
  };
  private current: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private jfCache: { key: string; client: Jellyfin } | null = null;

  constructor(db: DB) {
    this.db = db;
  }

  settings(): Settings {
    return getSettings(this.db);
  }

  jellyfin(s = this.settings()): Jellyfin | null {
    if (!s.jellyfinUrl || !s.jellyfinApiKey) return null;
    const key = s.jellyfinUrl + "\n" + s.jellyfinApiKey;
    if (this.jfCache?.key !== key) this.jfCache = { key, client: new Jellyfin(s.jellyfinUrl, s.jellyfinApiKey) };
    return this.jfCache.client;
  }

  seerr(s = this.settings()): Seerr | null {
    if (!s.seerrUrl || !s.seerrApiKey) return null;
    return new Seerr(s.seerrUrl, s.seerrApiKey);
  }

  // --- Scheduling ---------------------------------------------------------------

  start() {
    this.schedule(5_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
  }

  private schedule(delayMs?: number) {
    if (this.timer) clearTimeout(this.timer);
    const minutes = Math.max(1, this.settings().syncIntervalMinutes || 15);
    const delay = delayMs ?? minutes * 60_000;
    this.status.nextAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.sync("schedule").catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  /** A webhook fired: sync soon, folding a burst of events into one run. */
  poke(reason: string) {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.sync(reason).catch(() => {});
    }, 5_000);
    this.debounce.unref?.();
  }

  /** Runs a sync, or joins the running one and queues another after it. */
  sync(reason: string): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce(reason);
        } while (this.again);
      } finally {
        this.current = null;
        this.schedule();
      }
    })();
    return this.current;
  }

  private async runOnce(reason: string) {
    const s = this.settings();
    const jf = this.jellyfin(s);
    if (!jf) return;
    this.status = { ...this.status, running: true, startedAt: Date.now(), reason, error: null };
    const stats: SyncStats = {
      items: 0,
      tagged: 0,
      adopted: 0,
      fromRequests: 0,
      fromRule: 0,
      pendingRequests: 0,
      suggestions: 0,
      errors: 0,
    };
    try {
      await this.refreshLibrary(jf, s, stats);
      const people = listPeople(this.db);
      this.adoptExistingTags(people, stats);
      const seerr = this.seerr(s);
      if (seerr) await this.applyRequests(seerr, people, stats);
      this.applyUnrequestedRule(s, people, stats);
      if (s.watchSuggestions) await this.refreshSuggestions(jf, people, stats);
      await this.pushTags(jf, people, stats);
      if (s.tagChildren) await this.syncChildren(jf, people, stats);
      stats.pendingRequests = (
        this.db.prepare("SELECT count(*) AS n FROM requests WHERE item_id IS NULL AND status != ?").get(REQUEST_DECLINED) as { n: number }
      ).n;
      stats.suggestions = (this.db.prepare("SELECT count(*) AS n FROM suggestions WHERE dismissed = 0").get() as { n: number }).n;
      const changes = stats.tagged + stats.fromRequests + stats.fromRule;
      if (changes || stats.adopted) {
        logActivity(
          this.db,
          "sync",
          `Sync: ${plural(stats.fromRequests, "request")} matched, ${plural(stats.tagged, "tag")} written` +
            (stats.adopted ? `, ${plural(stats.adopted, "existing tag")} picked up` : "") +
            (stats.fromRule ? `, ${plural(stats.fromRule, "unrequested item")} assigned` : ""),
        );
      }
      this.status = { ...this.status, running: false, finishedAt: Date.now(), ok: stats.errors === 0, stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logActivity(this.db, "error", `Sync failed: ${message}`);
      this.status = { ...this.status, running: false, finishedAt: Date.now(), ok: false, error: message, stats };
    }
  }

  // --- Steps --------------------------------------------------------------------

  private async refreshLibrary(jf: Jellyfin, s: Settings, stats: SyncStats) {
    const media = await jf.allMedia(s.libraries);
    const upsert = this.db.prepare(`
      INSERT INTO items (id, type, name, sort_name, year, tmdb_id, tvdb_id, imdb_id, library_id, tags, child_count, date_created, has_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        type = excluded.type, name = excluded.name, sort_name = excluded.sort_name, year = excluded.year,
        tmdb_id = excluded.tmdb_id, tvdb_id = excluded.tvdb_id, imdb_id = excluded.imdb_id,
        library_id = excluded.library_id, tags = excluded.tags, child_count = excluded.child_count,
        date_created = excluded.date_created, has_image = excluded.has_image
    `);
    tx(this.db, () => {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY); DELETE FROM seen;");
      const seen = this.db.prepare("INSERT OR IGNORE INTO seen (id) VALUES (?)");
      for (const item of media) {
        if (item.Type !== "Movie" && item.Type !== "Series") continue;
        const ids = lowerKeys(item.ProviderIds ?? {});
        upsert.run(
          item.Id,
          item.Type,
          item.Name,
          item.SortName || item.Name,
          item.ProductionYear ?? null,
          ids.tmdb || null,
          ids.tvdb || null,
          ids.imdb || null,
          item.LibraryId ?? null,
          JSON.stringify(item.Tags ?? []),
          item.RecursiveItemCount ?? item.ChildCount ?? null,
          item.DateCreated ?? null,
          item.ImageTags?.Primary ? 1 : 0,
        );
        seen.run(item.Id);
      }
      // Gone from Jellyfin (deleted, or outside the chosen libraries).
      this.db.exec("DELETE FROM items WHERE id NOT IN (SELECT id FROM seen)");
      // A requested item that left Jellyfin gets its requester's tag again if
      // it comes back (a re-download gets a new Jellyfin id).
      this.db.exec(
        "UPDATE requests SET item_id = NULL, applied = 0 WHERE item_id IS NOT NULL AND item_id NOT IN (SELECT id FROM items)",
      );
    });
    stats.items = media.length;
  }

  private adoptExistingTags(people: Person[], stats: SyncStats) {
    if (!people.length) return;
    const items = this.db.prepare("SELECT id, tags FROM items").all() as { id: string; tags: string }[];
    const assigned = this.assignedSet();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO assignments (item_id, person_id, source, created_at) VALUES (?, ?, 'jellyfin', ?)",
    );
    tx(this.db, () => {
      for (const item of items) {
        const tags = JSON.parse(item.tags) as string[];
        for (const p of people) {
          if (hasTag(tags, p.tag) && !assigned.has(`${item.id}:${p.id}`)) {
            insert.run(item.id, p.id, Date.now());
            stats.adopted++;
          }
        }
      }
    });
  }

  private async applyRequests(seerr: Seerr, people: Person[], stats: SyncStats) {
    const requests = await seerr.requests();
    const upsert = this.db.prepare(`
      INSERT INTO requests (id, media_type, tmdb_id, tvdb_id, jellyfin_media_id, seerr_user_id, requested_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        media_type = excluded.media_type, tmdb_id = excluded.tmdb_id, tvdb_id = excluded.tvdb_id,
        jellyfin_media_id = excluded.jellyfin_media_id, seerr_user_id = excluded.seerr_user_id,
        requested_by = excluded.requested_by, status = excluded.status, created_at = excluded.created_at
    `);
    tx(this.db, () => {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS seen_requests (id INTEGER PRIMARY KEY); DELETE FROM seen_requests;");
      const seen = this.db.prepare("INSERT OR IGNORE INTO seen_requests (id) VALUES (?)");
      for (const r of requests) {
        const type = r.type || r.media?.mediaType;
        upsert.run(
          r.id,
          type,
          r.media?.tmdbId != null ? String(r.media.tmdbId) : null,
          r.media?.tvdbId != null ? String(r.media.tvdbId) : null,
          r.media?.jellyfinMediaId || null,
          r.requestedBy?.id ?? null,
          seerrUserName(r.requestedBy),
          r.status,
          r.createdAt ?? null,
        );
        seen.run(r.id);
      }
      this.db.exec("DELETE FROM requests WHERE id NOT IN (SELECT id FROM seen_requests)");
    });

    const bySeerrUser = new Map(people.filter((p) => p.seerr_user_id != null).map((p) => [p.seerr_user_id, p]));
    const rows = this.db.prepare("SELECT * FROM requests WHERE status != ?").all(REQUEST_DECLINED) as unknown as RequestRow[];
    const setMatch = this.db.prepare("UPDATE requests SET item_id = ? WHERE id = ?");
    const markApplied = this.db.prepare("UPDATE requests SET applied = 1 WHERE id = ?");
    let titleLookups = 0;
    for (const req of rows) {
      const itemId = this.matchRequest(req);
      if (itemId !== req.item_id) setMatch.run(itemId, req.id);
      if (!itemId) {
        // Not in Jellyfin yet: fetch a title so the Requests page can show it.
        if (!req.title && req.tmdb_id && titleLookups < 25) {
          titleLookups++;
          try {
            const t = await seerr.title(req.media_type === "tv" ? "tv" : "movie", req.tmdb_id);
            this.db.prepare("UPDATE requests SET title = ?, year = ? WHERE id = ?").run(t.title, t.year, req.id);
          } catch {
            // Cosmetic only; try again next sync.
          }
        }
        continue;
      }
      if (req.applied) continue;
      const person = bySeerrUser.get(req.seerr_user_id);
      if (!person) continue; // Requester not linked to anyone yet; applied once they are.
      const added = this.assign(itemId, person.id, "request");
      markApplied.run(req.id);
      if (added) {
        stats.fromRequests++;
        const item = this.item(itemId);
        logActivity(this.db, "tagged", `${item?.name ?? "An item"} → ${person.name} (requested in Seerr)`, {
          itemId,
          personId: person.id,
        });
      }
    }
  }

  matchRequest(req: Pick<RequestRow, "media_type" | "tmdb_id" | "tvdb_id" | "jellyfin_media_id">): string | null {
    if (req.jellyfin_media_id) {
      const hit = this.db.prepare("SELECT id FROM items WHERE id = ?").get(req.jellyfin_media_id) as { id: string } | undefined;
      if (hit) return hit.id;
    }
    const type = req.media_type === "tv" ? "Series" : "Movie";
    if (req.tmdb_id) {
      const hit = this.db.prepare("SELECT id FROM items WHERE type = ? AND tmdb_id = ?").get(type, req.tmdb_id) as
        | { id: string }
        | undefined;
      if (hit) return hit.id;
    }
    if (req.tvdb_id && type === "Series") {
      const hit = this.db.prepare("SELECT id FROM items WHERE type = 'Series' AND tvdb_id = ?").get(req.tvdb_id) as
        | { id: string }
        | undefined;
      if (hit) return hit.id;
    }
    return null;
  }

  private applyUnrequestedRule(s: Settings, people: Person[], stats: SyncStats) {
    if (s.unrequestedAction !== "tag") return;
    const targets = people.filter((p) => s.unrequestedPeople.includes(p.id));
    if (!targets.length) return;
    const cutoff = new Date(Date.now() - Math.max(0, s.unrequestedGraceHours) * 3_600_000).toISOString();
    // Untagged, old enough, never handled by the rule, and nobody's request.
    const items = this.db
      .prepare(
        `SELECT id, name FROM items i
         WHERE rule_applied = 0
           AND (date_created IS NULL OR date_created <= ?)
           AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.item_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.item_id = i.id AND r.status != ?)`,
      )
      .all(cutoff, REQUEST_DECLINED) as { id: string; name: string }[];
    const done = this.db.prepare("UPDATE items SET rule_applied = 1 WHERE id = ?");
    for (const item of items) {
      for (const p of targets) this.assign(item.id, p.id, "rule");
      done.run(item.id);
      stats.fromRule++;
    }
    if (items.length) {
      logActivity(
        this.db,
        "tagged",
        `${plural(items.length, "unrequested item")} → ${targets.map((p) => p.name).join(", ")} (rule)`,
      );
    }
  }

  private async refreshSuggestions(jf: Jellyfin, people: Person[], stats: SyncStats) {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO suggestions (item_id, person_id, reason)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM items WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM assignments WHERE item_id = ? AND person_id = ?)`,
    );
    for (const p of people) {
      if (!p.jellyfin_user_id) continue;
      try {
        const watched = await jf.watchedBy(p.jellyfin_user_id);
        tx(this.db, () => {
          for (const id of watched.movies) insert.run(id, p.id, "watched", id, id, p.id);
          for (const id of watched.series) insert.run(id, p.id, "watched", id, id, p.id);
        });
      } catch (err) {
        stats.errors++;
        logActivity(this.db, "error", `Couldn't read ${p.name}'s watch history: ${errorText(err)}`, { personId: p.id });
      }
    }
    this.db.exec(
      "DELETE FROM suggestions WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.item_id = suggestions.item_id AND a.person_id = suggestions.person_id)",
    );
  }

  /** Writes every assigned tag that Jellyfin is missing. */
  private async pushTags(jf: Jellyfin, people: Person[], stats: SyncStats) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = this.db
      .prepare(
        `SELECT i.id, i.name, i.tags, group_concat(a.person_id) AS person_ids
         FROM items i JOIN assignments a ON a.item_id = i.id GROUP BY i.id`,
      )
      .all() as { id: string; name: string; tags: string; person_ids: string }[];
    for (const row of rows) {
      const tags = JSON.parse(row.tags) as string[];
      const missing = row.person_ids
        .split(",")
        .map((id) => byId.get(Number(id)))
        .filter((p): p is Person => !!p && !hasTag(tags, p.tag))
        .map((p) => p.tag);
      if (!missing.length) continue;
      try {
        const next = await jf.editTags(row.id, missing, []);
        this.db.prepare("UPDATE items SET tags = ?, children_synced = NULL WHERE id = ?").run(JSON.stringify(next), row.id);
        stats.tagged += missing.length;
      } catch (err) {
        stats.errors++;
        logActivity(this.db, "error", `Couldn't tag ${row.name}: ${errorText(err)}`, { itemId: row.id });
      }
    }
  }

  /** Copies people's tags from each series to its seasons and episodes. */
  private async syncChildren(jf: Jellyfin, people: Person[], stats: SyncStats) {
    const series = this.db
      .prepare(
        "SELECT * FROM items WHERE type = 'Series' AND (children_synced IS NULL OR children_synced != coalesce(child_count, -1))",
      )
      .all() as unknown as ItemRow[];
    for (const s of series) {
      try {
        await this.copyTagsToChildren(jf, s, people);
        this.db.prepare("UPDATE items SET children_synced = coalesce(child_count, -1) WHERE id = ?").run(s.id);
      } catch (err) {
        stats.errors++;
        logActivity(this.db, "error", `Couldn't tag episodes of ${s.name}: ${errorText(err)}`, { itemId: s.id });
      }
    }
  }

  private async copyTagsToChildren(jf: Jellyfin, series: ItemRow, people: Person[]) {
    const own = this.assignedPeople(series.id);
    const want = people.filter((p) => own.has(p.id)).map((p) => p.tag);
    const dontWant = people.filter((p) => !own.has(p.id)).map((p) => p.tag);
    for (const child of await jf.children(series.id)) {
      const tags = child.Tags ?? [];
      const add = want.filter((t) => !hasTag(tags, t));
      const remove = dontWant.filter((t) => hasTag(tags, t));
      if (add.length || remove.length) await jf.editTags(child.Id, add, remove);
    }
  }

  // --- Manual changes -------------------------------------------------------------

  /**
   * Adds and/or removes people on items, in Jellyfin first and then here, so
   * the record only changes when Jellyfin accepted it.
   */
  async changeTags(
    itemIds: string[],
    addIds: number[],
    removeIds: number[],
    source = "manual",
  ): Promise<{ ok: number; failed: { id: string; error: string }[] }> {
    const s = this.settings();
    const jf = this.jellyfin(s);
    if (!jf) throw new Error("Jellyfin isn't connected");
    const people = listPeople(this.db);
    const add = people.filter((p) => addIds.includes(p.id));
    const remove = people.filter((p) => removeIds.includes(p.id));
    const failed: { id: string; error: string }[] = [];
    let ok = 0;
    for (const id of itemIds) {
      const item = this.item(id);
      if (!item) {
        failed.push({ id, error: "Not in the library" });
        continue;
      }
      try {
        const next = await jf.editTags(
          id,
          add.map((p) => p.tag),
          remove.map((p) => p.tag),
        );
        tx(this.db, () => {
          this.db.prepare("UPDATE items SET tags = ? WHERE id = ?").run(JSON.stringify(next), id);
          for (const p of add) this.assign(id, p.id, source);
          for (const p of remove) {
            this.db.prepare("DELETE FROM assignments WHERE item_id = ? AND person_id = ?").run(id, p.id);
            // Taking someone off counts as handling their suggestion, too.
            this.db.prepare("UPDATE suggestions SET dismissed = 1 WHERE item_id = ? AND person_id = ?").run(id, p.id);
          }
          this.db.prepare("UPDATE items SET rule_applied = 1 WHERE id = ?").run(id);
        });
        if (s.tagChildren && item.type === "Series") {
          await this.copyTagsToChildren(jf, item, people);
          this.db.prepare("UPDATE items SET children_synced = coalesce(child_count, -1) WHERE id = ?").run(id);
        }
        ok++;
      } catch (err) {
        failed.push({ id, error: errorText(err) });
      }
    }
    if (ok) {
      const parts = [
        add.length ? `+${add.map((p) => p.name).join(", +")}` : "",
        remove.length ? `−${remove.map((p) => p.name).join(", −")}` : "",
      ].filter(Boolean);
      const what = ok === 1 ? (this.item(itemIds.find((id) => !failed.some((f) => f.id === id))!)?.name ?? "1 item") : `${ok} items`;
      logActivity(this.db, remove.length && !add.length ? "untagged" : "tagged", `${what}: ${parts.join(" ")}`, {
        itemId: ok === 1 ? itemIds[0] : null,
      });
    }
    for (const f of failed) {
      logActivity(this.db, "error", `Couldn't change tags on ${this.item(f.id)?.name ?? f.id}: ${f.error}`, { itemId: f.id });
    }
    return { ok, failed };
  }

  /** Renames a person's tag on every item that has it. */
  async renameTag(person: Person, newTag: string) {
    const jf = this.jellyfin();
    const ids = (
      this.db.prepare("SELECT item_id FROM assignments WHERE person_id = ?").all(person.id) as { item_id: string }[]
    ).map((r) => r.item_id);
    if (jf) {
      for (const id of ids) {
        const next = await jf.editTags(id, [newTag], newTag.toLowerCase() === person.tag.toLowerCase() ? [] : [person.tag]);
        this.db.prepare("UPDATE items SET tags = ?, children_synced = NULL WHERE id = ?").run(JSON.stringify(next), id);
      }
    }
  }

  /** Takes a person's tag off every item (used when deleting them). */
  async removeTagEverywhere(person: Person) {
    const jf = this.jellyfin();
    if (!jf) return;
    const items = this.db.prepare("SELECT id, tags FROM items").all() as { id: string; tags: string }[];
    for (const item of items) {
      if (!hasTag(JSON.parse(item.tags), person.tag)) continue;
      const next = await jf.editTags(item.id, [], [person.tag]);
      this.db.prepare("UPDATE items SET tags = ?, children_synced = NULL WHERE id = ?").run(JSON.stringify(next), item.id);
    }
  }

  // --- Helpers --------------------------------------------------------------------

  /** Returns true when this is a new assignment. */
  private assign(itemId: string, personId: number, source: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO assignments (item_id, person_id, source, created_at) VALUES (?, ?, ?, ?)")
      .run(itemId, personId, source, Date.now());
    if (res.changes) this.db.prepare("DELETE FROM suggestions WHERE item_id = ? AND person_id = ?").run(itemId, personId);
    return res.changes > 0;
  }

  private assignedSet(): Set<string> {
    const rows = this.db.prepare("SELECT item_id, person_id FROM assignments").all() as { item_id: string; person_id: number }[];
    return new Set(rows.map((r) => `${r.item_id}:${r.person_id}`));
  }

  private assignedPeople(itemId: string): Set<number> {
    const rows = this.db.prepare("SELECT person_id FROM assignments WHERE item_id = ?").all(itemId) as { person_id: number }[];
    return new Set(rows.map((r) => r.person_id));
  }

  item(id: string): ItemRow | undefined {
    return this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as ItemRow | undefined;
  }
}

export interface RequestRow {
  id: number;
  media_type: "movie" | "tv";
  tmdb_id: string | null;
  tvdb_id: string | null;
  jellyfin_media_id: string | null;
  seerr_user_id: number | null;
  requested_by: string | null;
  status: number;
  title: string | null;
  year: number | null;
  created_at: string | null;
  item_id: string | null;
  applied: number;
}

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (err.name === "TimeoutError") return "timed out";
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}
