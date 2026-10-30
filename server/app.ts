// HTTP API and static frontend.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import {
  type DB,
  type ItemRow,
  type Person,
  type SeasonRow,
  type Settings,
  getSettings,
  listPeople,
  listSeasons,
  logActivity,
  saveSettings,
  seasonPeople,
  tx,
} from "./db.ts";
import {
  LoginLimiter,
  SESSION_COOKIE,
  createSession,
  createWidgetKey,
  deleteAllSessions,
  deleteSession,
  hashPassword,
  randomSecret,
  safeEqual,
  useWidgetKey,
  validSession,
  verifyPassword,
} from "./auth.ts";
import { Engine, type RequestRow, errorText } from "./engine.ts";
import { Jellyfin, hasTag } from "./jellyfin.ts";
import { REQUEST_DECLINED, Seerr, seerrUserName } from "./seerr.ts";
import { checkWindow, seasonStatus } from "./seasons.ts";
import { UpdateChecker, isNewer } from "./update-check.ts";

export interface AppOptions {
  db: DB;
  version: string;
  repo: string;
  updateCheck: boolean;
  webRoot?: string;
  logger?: boolean;
}

export const PERSON_COLORS = ["#7c5cbf", "#d9677e", "#3f8f84", "#d08a3a", "#4f7cc0", "#8a9a3b", "#b4589f", "#5c6b7a"];

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; engine: Engine; updates: UpdateChecker }> {
  const { db } = opts;
  const engine = new Engine(db);
  const updates = new UpdateChecker(opts.updateCheck, opts.repo);
  const limiter = new LoginLimiter();

  // Generated once, kept in the database: the webhook needs a secret URL.
  if (!getSettings(db).webhookSecret) saveSettings(db, { webhookSecret: randomSecret() });

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  const isAuthed = (req: FastifyRequest) => validSession(db, req.cookies[SESSION_COOKIE]);
  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply) => {
    const { token, maxAge } = createSession(db);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.protocol === "https",
      maxAge,
    });
  };

  // Everything under /api needs a session except these.
  const PUBLIC = new Set(["/api/health", "/api/session", "/api/login", "/api/account/create", "/api/widget"]);
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || PUBLIC.has(url) || url.startsWith("/api/webhook")) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "Sign in first" });
  });

  // --- Session & account ---------------------------------------------------------

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/session", async (req) => {
    const s = getSettings(db);
    return {
      authenticated: isAuthed(req),
      needsAccount: !s.adminPasswordHash,
      setupComplete: s.setupComplete,
      version: opts.version,
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/account/create", async (req, reply) => {
    const s = getSettings(db);
    if (s.adminPasswordHash) return reply.code(409).send({ error: "An account already exists. Sign in instead." });
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!username) return reply.code(400).send({ error: "Choose a username" });
    if (password.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminUsername: username, adminPasswordHash: hashPassword(password) });
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
    const s = getSettings(db);
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const ok =
      !!s.adminPasswordHash &&
      username.toLowerCase() === s.adminUsername.toLowerCase() &&
      verifyPassword(password, s.adminPasswordHash);
    if (!ok) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    limiter.reset(req.ip);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>("/api/account/password", async (req, reply) => {
    const s = getSettings(db);
    if (!verifyPassword(String(req.body?.current ?? ""), s.adminPasswordHash)) {
      return reply.code(400).send({ error: "The current password is wrong" });
    }
    const next = String(req.body?.next ?? "");
    if (next.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminPasswordHash: hashPassword(next) });
    deleteAllSessions(db);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.get("/api/about", async () => ({
    version: opts.version,
    repo: opts.repo,
    update: updates.info,
    updateAvailable: isNewer(updates.info.latest, opts.version),
  }));

  // --- Webhook -------------------------------------------------------------------
  // Point Seerr's webhook agent (and optionally Jellyfin's webhook plugin) at
  // /api/webhook/<secret>. The body isn't trusted for anything: any call just
  // schedules a sync, which reads the truth from both APIs.

  const webhook = async (req: FastifyRequest<{ Params: { token?: string }; Querystring: { token?: string } }>, reply: FastifyReply) => {
    const s = getSettings(db);
    const header = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const token = req.params.token || req.query.token || header;
    if (!token || !safeEqual(token, s.webhookSecret)) return reply.code(401).send({ error: "Bad webhook token" });
    engine.poke("webhook");
    return { ok: true };
  };
  app.post("/api/webhook", webhook);
  app.post("/api/webhook/:token", webhook);
  // Seerr's "Test" button and some plugins send bodies Fastify doesn't parse by default.
  app.addContentTypeParser("*", { parseAs: "string" }, (req, body, done) => {
    if ((req.url ?? "").startsWith("/api/webhook")) return done(null, body);
    const err = new Error("Send JSON") as Error & { statusCode: number };
    err.statusCode = 415;
    done(err, undefined);
  });

  // --- Overview --------------------------------------------------------------------

  const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;

  function totals() {
    return {
      items: count("SELECT count(*) AS n FROM items"),
      movies: count("SELECT count(*) AS n FROM items WHERE type = 'Movie'"),
      shows: count("SELECT count(*) AS n FROM items WHERE type = 'Series'"),
      // Seasonal titles are untagged on purpose out of season, so they don't count.
      untagged: count(
        `SELECT count(*) AS n FROM items i WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.item_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM season_items s WHERE s.item_id = i.id)`,
      ),
      seasonal: count("SELECT count(DISTINCT si.item_id) AS n FROM season_items si JOIN items i ON i.id = si.item_id"),
      shared: count("SELECT count(*) AS n FROM (SELECT item_id FROM assignments GROUP BY item_id HAVING count(*) > 1)"),
      pendingRequests: count("SELECT count(*) AS n FROM requests WHERE item_id IS NULL AND status != ?", REQUEST_DECLINED),
      unmappedRequests: count(
        `SELECT count(*) AS n FROM requests r WHERE status != ? AND applied = 0 AND item_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM people p WHERE p.seerr_user_id = r.seerr_user_id)
         AND coalesce(r.seerr_user_id, -1) NOT IN (SELECT value FROM json_each(?))`,
        REQUEST_DECLINED,
        JSON.stringify(getSettings(db).ignoredSeerrUsers),
      ),
      suggestions: count("SELECT count(*) AS n FROM suggestions WHERE dismissed = 0"),
    };
  }

  app.get("/api/overview", async () => {
    const s = getSettings(db);
    const people = listPeople(db);
    const perPerson = people.map((p) => ({
      ...publicPerson(p),
      count: count("SELECT count(*) AS n FROM assignments WHERE person_id = ?", p.id),
      onlyCount: count(
        "SELECT count(*) AS n FROM assignments a WHERE person_id = ? AND (SELECT count(*) FROM assignments b WHERE b.item_id = a.item_id) = 1",
        p.id,
      ),
    }));
    const activity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 12").all();
    return {
      connections: { jellyfin: !!(s.jellyfinUrl && s.jellyfinApiKey), seerr: !!(s.seerrUrl && s.seerrApiKey) },
      totals: totals(),
      seasons: listSeasons(db).map(publicSeason),
      people: perPerson,
      activity,
      sync: engine.status,
    };
  });

  // --- Homepage widget -----------------------------------------------------------------
  // Read-only numbers for dashboards (Homepage's "Custom API" widget, or
  // anything that can GET JSON). Authenticated by a key in the X-Api-Key
  // header, made in Settings; no session, since the caller is a server.

  app.get("/api/widget", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!useWidgetKey(db, Array.isArray(key) ? key[0] : key)) return reply.code(401).send({ error: "Missing or unknown X-Api-Key" });
    const t = totals();
    const people = listPeople(db).map((p) => ({
      name: p.name,
      tag: p.tag,
      count: count("SELECT count(*) AS n FROM assignments WHERE person_id = ?", p.id),
    }));
    const status = engine.status;
    return {
      untagged: t.untagged,
      shared: t.shared,
      waiting: t.pendingRequests,
      suggestions: t.suggestions,
      unlinked_requests: t.unmappedRequests,
      total: t.items,
      movies: t.movies,
      shows: t.shows,
      tagged_pct: t.items ? Math.round(((t.items - t.untagged) / t.items) * 100) : 100,
      last_sync: status.finishedAt ? new Date(status.finishedAt).toISOString() : null,
      last_sync_ok: status.ok,
      // Per person, by tag, e.g. people.Owen (Homepage: field: { people: Owen }).
      people: Object.fromEntries(people.map((p) => [p.tag, p.count])),
    };
  });

  app.get("/api/widget-keys", async () =>
    db.prepare("SELECT id, label, created_at, last_used_at FROM widget_keys ORDER BY id").all(),
  );

  app.post<{ Body: { label?: string } }>("/api/widget-keys", async (req) => {
    const label = String(req.body?.label ?? "").trim().slice(0, 60) || "Homepage";
    const created = createWidgetKey(db, label);
    logActivity(db, "access", `Created widget key “${label}”`);
    return created;
  });

  app.delete<{ Params: { id: string } }>("/api/widget-keys/:id", async (req, reply) => {
    const row = db.prepare("SELECT label FROM widget_keys WHERE id = ?").get(Number(req.params.id)) as { label: string } | undefined;
    if (!row) return reply.code(404).send({ error: "No such key" });
    db.prepare("DELETE FROM widget_keys WHERE id = ?").run(Number(req.params.id));
    logActivity(db, "access", `Revoked widget key “${row.label}”`);
    return { ok: true };
  });

  // --- Items -----------------------------------------------------------------------

  app.get<{
    Querystring: { filter?: string; type?: string; q?: string; sort?: string; offset?: string; limit?: string };
  }>("/api/items", async (req) => {
    const { filter = "all", type = "", q = "", sort = "added" } = req.query;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (type === "Movie" || type === "Series") {
      where.push("i.type = ?");
      args.push(type);
    }
    if (q.trim()) {
      where.push("i.name LIKE ? ESCAPE '\\'");
      args.push(`%${q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    }
    const assignedCount = "(SELECT count(*) FROM assignments a WHERE a.item_id = i.id)";
    const seasonal = "EXISTS (SELECT 1 FROM season_items si WHERE si.item_id = i.id)";
    if (filter === "untagged") where.push(`${assignedCount} = 0 AND NOT ${seasonal}`);
    else if (filter === "seasonal") where.push(seasonal);
    else if (filter === "shared") where.push(`${assignedCount} > 1`);
    else if (filter === "suggested") where.push("EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)");
    else if (filter.startsWith("person:")) {
      where.push("EXISTS (SELECT 1 FROM assignments a WHERE a.item_id = i.id AND a.person_id = ?)");
      args.push(Number(filter.slice(7)));
    } else if (filter.startsWith("only:")) {
      where.push(`EXISTS (SELECT 1 FROM assignments a WHERE a.item_id = i.id AND a.person_id = ?) AND ${assignedCount} = 1`);
      args.push(Number(filter.slice(5)));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = sort === "name" ? "i.sort_name COLLATE NOCASE" : sort === "year" ? "i.year DESC, i.sort_name" : "i.date_created DESC, i.sort_name";
    const total = (db.prepare(`SELECT count(*) AS n FROM items i ${whereSql}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM items i ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as ItemRow[];
    return { total, items: decorateItems(rows) };
  });

  function decorateItems(rows: ItemRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const assigns = db
      .prepare(`SELECT item_id, person_id, source FROM assignments WHERE item_id IN (${marks})`)
      .all(...ids) as { item_id: string; person_id: number; source: string }[];
    const suggestions = db
      .prepare(`SELECT item_id, person_id FROM suggestions WHERE dismissed = 0 AND item_id IN (${marks})`)
      .all(...ids) as { item_id: string; person_id: number }[];
    const requests = db
      .prepare(`SELECT item_id, requested_by FROM requests WHERE status != ? AND item_id IN (${marks})`)
      .all(REQUEST_DECLINED, ...ids) as { item_id: string; requested_by: string }[];
    const people = listPeople(db);
    const inSeasons = db
      .prepare(`SELECT si.item_id, s.* FROM season_items si JOIN seasons s ON s.id = si.season_id WHERE si.item_id IN (${marks})`)
      .all(...ids) as unknown as (SeasonRow & { item_id: string })[];
    const now = new Date();
    return rows.map((r) => {
      const mine = assigns.filter((a) => a.item_id === r.id);
      const tags = JSON.parse(r.tags) as string[];
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        year: r.year,
        dateCreated: r.date_created,
        hasImage: !!r.has_image,
        people: mine.map((a) => ({ id: a.person_id, source: a.source })),
        suggested: suggestions.filter((s) => s.item_id === r.id).map((s) => s.person_id),
        requestedBy: [...new Set(requests.filter((q) => q.item_id === r.id).map((q) => q.requested_by))],
        otherTags: tags.filter((t) => !people.some((p) => p.tag.toLowerCase() === t.toLowerCase())),
        seasons: inSeasons
          .filter((x) => x.item_id === r.id)
          .map((x) => ({ id: x.id, name: x.name, active: seasonStatus(x, now).active, people: seasonPeople(x) })),
      };
    });
  }

  app.get<{ Params: { id: string } }>("/api/items/:id/image", async (req, reply) => {
    const jf = engine.jellyfin();
    if (!jf || !/^[0-9a-f-]{8,64}$/i.test(req.params.id)) return reply.code(404).send();
    try {
      const res = await jf.image(req.params.id, 360);
      if (!res.ok || !res.body) return reply.code(404).send();
      reply.header("Content-Type", res.headers.get("content-type") ?? "image/jpeg");
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch {
      return reply.code(502).send();
    }
  });

  app.post<{ Body: { itemIds?: string[]; add?: number[]; remove?: number[] } }>("/api/items/tags", async (req, reply) => {
    const itemIds = arrayOf(req.body?.itemIds, "string").slice(0, 5000);
    const add = arrayOf(req.body?.add, "number");
    const remove = arrayOf(req.body?.remove, "number").filter((id) => !add.includes(id));
    if (!itemIds.length || (!add.length && !remove.length)) return reply.code(400).send({ error: "Nothing to change" });
    try {
      return await engine.changeTags(itemIds, add, remove);
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  app.get("/api/tags", async () => {
    const rows = db.prepare("SELECT tags FROM items").all() as { tags: string }[];
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  });

  // --- People ------------------------------------------------------------------------

  app.get("/api/people", async () => {
    return listPeople(db).map((p) => ({
      ...publicPerson(p),
      count: (db.prepare("SELECT count(*) AS n FROM assignments WHERE person_id = ?").get(p.id) as { n: number }).n,
    }));
  });

  app.post<{ Body: PersonBody }>("/api/people", async (req, reply) => {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    const tag = String(body.tag ?? name).trim();
    const problem = checkPerson(name, tag, null);
    if (problem) return reply.code(400).send({ error: problem });
    const used = new Set(listPeople(db).map((p) => p.color));
    const color = validColor(body.color) ?? PERSON_COLORS.find((c) => !used.has(c)) ?? PERSON_COLORS[0];
    const res = db
      .prepare("INSERT INTO people (name, tag, color, seerr_user_id, jellyfin_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, tag, color, numOrNull(body.seerrUserId), strOrNull(body.jellyfinUserId), Date.now());
    logActivity(db, "access", `Added ${name} (tag “${tag}”)`, { personId: Number(res.lastInsertRowid) });
    // Their requests and existing tags get picked up straight away.
    engine.poke("person added");
    return { id: Number(res.lastInsertRowid) };
  });

  app.patch<{ Params: { id: string }; Body: PersonBody }>("/api/people/:id", async (req, reply) => {
    const person = getPerson(Number(req.params.id));
    if (!person) return reply.code(404).send({ error: "No such person" });
    const body = req.body ?? {};
    const name = body.name !== undefined ? String(body.name).trim() : person.name;
    const tag = body.tag !== undefined ? String(body.tag).trim() : person.tag;
    const problem = checkPerson(name, tag, person.id);
    if (problem) return reply.code(400).send({ error: problem });
    if (tag !== person.tag) {
      try {
        await engine.renameTag(person, tag);
      } catch (err) {
        return reply.code(502).send({ error: `Couldn't rename the tag in Jellyfin: ${errorText(err)}` });
      }
      logActivity(db, "access", `Renamed tag “${person.tag}” to “${tag}”`, { personId: person.id });
    }
    const seerrChanged = body.seerrUserId !== undefined && numOrNull(body.seerrUserId) !== person.seerr_user_id;
    db.prepare("UPDATE people SET name = ?, tag = ?, color = ?, seerr_user_id = ?, jellyfin_user_id = ? WHERE id = ?").run(
      name,
      tag,
      validColor(body.color) ?? person.color,
      body.seerrUserId !== undefined ? numOrNull(body.seerrUserId) : person.seerr_user_id,
      body.jellyfinUserId !== undefined ? strOrNull(body.jellyfinUserId) : person.jellyfin_user_id,
      person.id,
    );
    if (seerrChanged || body.jellyfinUserId !== undefined) engine.poke("person changed");
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { removeTags?: string } }>("/api/people/:id", async (req, reply) => {
    const person = getPerson(Number(req.params.id));
    if (!person) return reply.code(404).send({ error: "No such person" });
    if (req.query.removeTags === "1") {
      try {
        await engine.removeTagEverywhere(person);
      } catch (err) {
        return reply.code(502).send({ error: `Couldn't remove the tag in Jellyfin: ${errorText(err)}` });
      }
    }
    db.prepare("DELETE FROM people WHERE id = ?").run(person.id);
    const s = getSettings(db);
    saveSettings(db, { unrequestedPeople: s.unrequestedPeople.filter((id) => id !== person.id) });
    logActivity(db, "access", `Removed ${person.name}${req.query.removeTags === "1" ? " and their tag" : ""}`);
    return { ok: true };
  });

  /** Users on both servers, for linking people (and suggesting who to add). */
  app.get("/api/remote-users", async () => {
    const s = getSettings(db);
    const out: {
      jellyfin: { id: string; name: string; isAdmin: boolean }[];
      seerr: { id: number; name: string; jellyfinUserId: string | null; requestCount: number }[];
      errors: string[];
    } = { jellyfin: [], seerr: [], errors: [] };
    const jf = engine.jellyfin(s);
    if (jf) {
      try {
        out.jellyfin = (await jf.users()).map((u) => ({ id: u.Id, name: u.Name, isAdmin: !!u.Policy?.IsAdministrator }));
      } catch (err) {
        out.errors.push(`Jellyfin: ${errorText(err)}`);
      }
    }
    const seerr = engine.seerr(s);
    if (seerr) {
      try {
        out.seerr = (await seerr.users()).map((u) => ({
          id: u.id,
          name: seerrUserName(u),
          jellyfinUserId: u.jellyfinUserId ?? null,
          requestCount: u.requestCount ?? 0,
        }));
      } catch (err) {
        out.errors.push(`Seerr: ${errorText(err)}`);
      }
    }
    return out;
  });

  // --- Seasons ----------------------------------------------------------------------------
  // A season shows a set of titles to some people between two dates (every
  // year, or once) and hides them the rest of the time; see engine.applySeasons.

  function publicSeason(row: SeasonRow) {
    const st = seasonStatus(row);
    const n = count("SELECT count(*) AS n FROM season_items si JOIN items i ON i.id = si.item_id WHERE si.season_id = ?", row.id);
    const missing = count("SELECT count(*) AS n FROM season_items si WHERE si.season_id = ? AND si.item_id NOT IN (SELECT id FROM items)", row.id);
    return {
      id: row.id,
      name: row.name,
      start: row.start_at,
      end: row.end_at,
      yearly: !!row.yearly,
      people: seasonPeople(row),
      collection: !!row.collection,
      collectionName: row.collection_name,
      collectionMade: !!row.collection_id,
      collectionGeneric: !!row.collection_generic,
      coverVersion: (db.prepare("SELECT version FROM season_covers WHERE season_id = ?").get(row.id) as { version: number } | undefined)?.version ?? null,
      itemCount: n,
      missingCount: missing,
      status: { active: st.active, over: st.over, start: st.start.toISOString(), end: st.end.toISOString() },
      applied: row.applied_active === (st.active ? 1 : 0),
    };
  }

  const getSeason = (id: number) => db.prepare("SELECT * FROM seasons WHERE id = ?").get(id) as unknown as SeasonRow | undefined;
  const seasonItemIds = (id: number) =>
    (db.prepare("SELECT item_id FROM season_items WHERE season_id = ?").all(id) as { item_id: string }[]).map((r) => r.item_id);

  /** Validates a season body against the current row (for edits). */
  function readSeason(body: SeasonBody, current?: SeasonRow): { error: string } | { value: Omit<SeasonRow, "id" | "created_at" | "collection_id" | "applied_active" | "cover_applied">; itemIds?: string[] } {
    const name = body.name !== undefined ? String(body.name).trim() : (current?.name ?? "");
    if (!name) return { error: "Give the season a name" };
    if (name.length > 100) return { error: "That name is too long" };
    const start = body.start !== undefined ? String(body.start) : (current?.start_at ?? "");
    const end = body.end !== undefined ? String(body.end) : (current?.end_at ?? "");
    const yearly = body.yearly !== undefined ? !!body.yearly : current ? !!current.yearly : true;
    const problem = checkWindow(start, end, yearly);
    if (problem) return { error: problem };
    const known = new Set(listPeople(db).map((p) => p.id));
    const people = body.people !== undefined ? arrayOf(body.people, "number").filter((id) => known.has(id)) : current ? seasonPeople(current) : [];
    const collection = body.collection !== undefined ? !!body.collection : !!current?.collection;
    const collectionGeneric = body.collectionGeneric !== undefined ? !!body.collectionGeneric : current ? !!current.collection_generic : true;
    const collectionName =
      body.collectionName !== undefined ? String(body.collectionName ?? "").trim().slice(0, 100) || null : (current?.collection_name ?? null);
    let itemIds: string[] | undefined;
    if (body.itemIds !== undefined) {
      const ids = [...new Set(arrayOf(body.itemIds, "string"))].slice(0, 5000);
      const marks = ids.map(() => "?").join(",");
      itemIds = ids.length ? (db.prepare(`SELECT id FROM items WHERE id IN (${marks})`).all(...ids) as { id: string }[]).map((r) => r.id) : [];
    }
    return {
      value: {
        name,
        start_at: start,
        end_at: end,
        yearly: yearly ? 1 : 0,
        people: JSON.stringify([...new Set(people)]),
        collection: collection ? 1 : 0,
        collection_name: collectionName,
        collection_generic: collectionGeneric ? 1 : 0,
      },
      itemIds,
    };
  }

  /** Puts items that are now in no season back to their usual tags (retried until it works), then syncs. */
  async function afterSeasonChange(released: string[], reason: string) {
    const free = released.filter((id) => engine.seasonsOf(id).length === 0);
    if (free.length) await engine.releaseItems(free);
    engine.poke(reason);
  }

  /** Adds titles to a season, remembering their online ids so they can be found again. */
  const addSeasonItem = () =>
    db.prepare(
      `INSERT OR IGNORE INTO season_items (season_id, item_id, media_type, tmdb_id, tvdb_id)
       SELECT ?, id, type, tmdb_id, tvdb_id FROM items WHERE id = ?`,
    );

  app.get("/api/seasons", async () => listSeasons(db).map(publicSeason));

  app.get<{ Params: { id: string } }>("/api/seasons/:id", async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    const items = db
      .prepare(
        `SELECT i.* FROM season_items si JOIN items i ON i.id = si.item_id WHERE si.season_id = ?
         ORDER BY i.sort_name COLLATE NOCASE`,
      )
      .all(row.id) as unknown as ItemRow[];
    return { ...publicSeason(row), items: items.map((i) => ({ id: i.id, name: i.name, year: i.year, type: i.type, hasImage: !!i.has_image })) };
  });

  app.post<{ Body: SeasonBody }>("/api/seasons", async (req, reply) => {
    const read = readSeason(req.body ?? {});
    if ("error" in read) return reply.code(400).send({ error: read.error });
    const v = read.value;
    const id = tx(db, () => {
      const res = db
        .prepare(
          `INSERT INTO seasons (name, start_at, end_at, yearly, people, collection, collection_name, collection_generic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(v.name, v.start_at, v.end_at, v.yearly, v.people, v.collection, v.collection_name, v.collection_generic, Date.now());
      const id = Number(res.lastInsertRowid);
      const add = addSeasonItem();
      for (const itemId of read.itemIds ?? []) add.run(id, itemId);
      return id;
    });
    logActivity(db, "season", `Added the ${v.name} season (${plural(read.itemIds?.length ?? 0, "title")})`);
    engine.poke("season added");
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: SeasonBody }>("/api/seasons/:id", async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    const read = readSeason(req.body ?? {}, row);
    if ("error" in read) return reply.code(400).send({ error: read.error });
    const v = read.value;
    const before = seasonItemIds(row.id);
    // Turning the collection off removes the one Tagarr made: left behind it
    // would keep whatever tags it last had.
    if (row.collection_id && !v.collection) {
      try {
        await engine.deleteCollection(row.collection_id);
      } catch (err) {
        return reply.code(502).send({ error: `Couldn't delete the collection in Jellyfin: ${errorText(err)}` });
      }
    }
    tx(db, () => {
      db.prepare(
        `UPDATE seasons SET name = ?, start_at = ?, end_at = ?, yearly = ?, people = ?, collection = ?, collection_name = ?,
         collection_generic = ?, collection_id = CASE WHEN ? THEN collection_id ELSE NULL END WHERE id = ?`,
      ).run(v.name, v.start_at, v.end_at, v.yearly, v.people, v.collection, v.collection_name, v.collection_generic, v.collection, row.id);
      if (read.itemIds) {
        // Titles missing from Jellyfin right now aren't in the list sent back; keep them.
        db.prepare("DELETE FROM season_items WHERE season_id = ? AND item_id IN (SELECT id FROM items)").run(row.id);
        const add = addSeasonItem();
        for (const itemId of read.itemIds) add.run(row.id, itemId);
      }
    });
    const after = new Set(seasonItemIds(row.id));
    await afterSeasonChange(before.filter((id) => !after.has(id)), "season changed");
    return publicSeason(getSeason(row.id)!);
  });

  /** Adds or removes titles without sending the whole list (bulk actions in the library). */
  app.post<{ Params: { id: string }; Body: { add?: string[]; remove?: string[] } }>("/api/seasons/:id/items", async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    const add = arrayOf(req.body?.add, "string").slice(0, 5000);
    const remove = arrayOf(req.body?.remove, "string").slice(0, 5000);
    let added = 0;
    tx(db, () => {
      const ins = addSeasonItem();
      for (const id of add) added += Number(ins.run(row.id, id).changes);
      const del = db.prepare("DELETE FROM season_items WHERE season_id = ? AND item_id = ?");
      for (const id of remove) del.run(row.id, id);
    });
    if (added) logActivity(db, "season", `Added ${plural(added, "title")} to ${row.name}`);
    await afterSeasonChange(remove, "season changed");
    return { ok: true, added };
  });

  // The season's cover, used as its collection's poster. Uploaded as the raw
  // image (not a form), so it's as CSRF-proof as the JSON routes: a cross-site
  // page can't send an image content type without a CORS preflight.
  const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
  app.addContentTypeParser(COVER_TYPES, { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get<{ Params: { id: string } }>("/api/seasons/:id/cover", async (req, reply) => {
    const cover = engine.cover(Number(req.params.id));
    if (!cover) return reply.code(404).send({ error: "No cover" });
    reply.header("Content-Type", cover.type);
    reply.header("Cache-Control", "private, max-age=31536000, immutable"); // the URL carries ?v=<version>
    return reply.send(Buffer.from(cover.data));
  });

  app.put<{ Params: { id: string }; Body: Buffer }>("/api/seasons/:id/cover", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const data = req.body;
    if (!COVER_TYPES.includes(type) || !Buffer.isBuffer(data) || imageType(data) !== type) {
      return reply.code(400).send({ error: "Use a JPEG, PNG or WebP image" });
    }
    db.prepare(
      `INSERT INTO season_covers (season_id, type, data, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (season_id) DO UPDATE SET type = excluded.type, data = excluded.data, version = excluded.version`,
    ).run(row.id, type, data, Date.now());
    logActivity(db, "season", `New cover for ${row.name}`);
    engine.poke("season cover");
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/seasons/:id/cover", async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    db.prepare("DELETE FROM season_covers WHERE season_id = ?").run(row.id);
    engine.poke("season cover");
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { keepCollection?: string } }>("/api/seasons/:id", async (req, reply) => {
    const row = getSeason(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such season" });
    if (row.collection_id && req.query.keepCollection !== "1") {
      try {
        await engine.deleteCollection(row.collection_id);
      } catch (err) {
        return reply.code(502).send({ error: `Couldn't delete the collection in Jellyfin: ${errorText(err)}` });
      }
    }
    const items = seasonItemIds(row.id);
    db.prepare("DELETE FROM seasons WHERE id = ?").run(row.id);
    logActivity(db, "season", `Removed the ${row.name} season`);
    await afterSeasonChange(items, "season removed");
    return { ok: true };
  });

  // --- Requests & suggestions ----------------------------------------------------------

  app.get("/api/requests", async () => {
    const rows = db
      .prepare(
        `SELECT r.*, i.name AS item_name, i.year AS item_year, i.has_image, p.id AS person_id
         FROM requests r
         LEFT JOIN items i ON i.id = r.item_id
         LEFT JOIN people p ON p.seerr_user_id = r.seerr_user_id
         ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all() as unknown as (RequestRow & { item_name: string | null; item_year: number | null; has_image: number | null; person_id: number | null })[];
    const ignored = new Set(getSettings(db).ignoredSeerrUsers);
    return rows.map((r) => ({
      id: r.id,
      type: r.media_type,
      title: r.item_name ?? r.title ?? (r.tmdb_id ? `TMDB ${r.tmdb_id}` : "Unknown"),
      year: r.item_year ?? r.year,
      requestedBy: r.requested_by,
      seerrUserId: r.seerr_user_id,
      personId: r.person_id,
      createdAt: r.created_at,
      itemId: r.item_id,
      hasImage: !!r.has_image,
      state:
        r.status === REQUEST_DECLINED
          ? "declined"
          : !r.item_id
            ? "waiting"
            : r.person_id == null
              ? r.seerr_user_id != null && ignored.has(r.seerr_user_id)
                ? "ignored"
                : "unlinked"
              : r.applied
                ? "tagged"
                : "queued",
    }));
  });

  app.get("/api/suggestions", async () => {
    const rows = db
      .prepare(
        `SELECT s.item_id, s.person_id, s.reason, i.name, i.year, i.type, i.has_image
         FROM suggestions s JOIN items i ON i.id = s.item_id
         WHERE s.dismissed = 0 ORDER BY i.sort_name COLLATE NOCASE`,
      )
      .all() as { item_id: string; person_id: number; reason: string; name: string; year: number | null; type: string; has_image: number }[];
    return rows.map((r) => ({
      itemId: r.item_id,
      personId: r.person_id,
      reason: r.reason,
      name: r.name,
      year: r.year,
      type: r.type,
      hasImage: !!r.has_image,
    }));
  });

  app.post<{ Body: { pairs?: { itemId: string; personId: number }[] } }>("/api/suggestions/accept", async (req, reply) => {
    const pairs = (Array.isArray(req.body?.pairs) ? req.body.pairs : []).filter(
      (p) => typeof p?.itemId === "string" && typeof p?.personId === "number",
    );
    if (!pairs.length) return reply.code(400).send({ error: "Nothing to accept" });
    // Group by person so each person is one pass over their items.
    const byPerson = new Map<number, string[]>();
    for (const p of pairs) byPerson.set(p.personId, [...(byPerson.get(p.personId) ?? []), p.itemId]);
    let ok = 0;
    const failed: { id: string; error: string }[] = [];
    try {
      for (const [personId, itemIds] of byPerson) {
        const res = await engine.changeTags(itemIds, [personId], [], "watched");
        ok += res.ok;
        failed.push(...res.failed);
      }
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
    return { ok, failed };
  });

  app.post<{ Body: { pairs?: { itemId: string; personId: number }[] } }>("/api/suggestions/dismiss", async (req) => {
    const stmt = db.prepare("UPDATE suggestions SET dismissed = 1 WHERE item_id = ? AND person_id = ?");
    for (const p of Array.isArray(req.body?.pairs) ? req.body.pairs : []) stmt.run(String(p.itemId), Number(p.personId));
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/activity", async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    return db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit);
  });

  // --- Sync --------------------------------------------------------------------------

  app.get("/api/sync", async () => engine.status);

  app.post("/api/sync", async () => {
    const run = engine.sync("manual").catch(() => {});
    // Give a short sync the chance to finish so the button feels instant.
    await Promise.race([run, new Promise((r) => setTimeout(r, 1500))]);
    return engine.status;
  });

  // --- Settings & connections --------------------------------------------------------

  app.get<{ Querystring: { origin?: string } }>("/api/settings", async () => {
    const s = getSettings(db);
    return {
      jellyfinUrl: s.jellyfinUrl,
      jellyfinApiKeySet: !!s.jellyfinApiKey,
      seerrUrl: s.seerrUrl,
      seerrApiKeySet: !!s.seerrApiKey,
      libraries: s.libraries,
      syncIntervalMinutes: s.syncIntervalMinutes,
      tagChildren: s.tagChildren,
      watchSuggestions: s.watchSuggestions,
      unrequestedAction: s.unrequestedAction,
      unrequestedPeople: s.unrequestedPeople,
      unrequestedGraceHours: s.unrequestedGraceHours,
      ignoredSeerrUsers: s.ignoredSeerrUsers,
      webhookPath: `/api/webhook/${s.webhookSecret}`,
      adminUsername: s.adminUsername,
      setupComplete: s.setupComplete,
    };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    const patch: Partial<Settings> = {};
    for (const key of ["jellyfinUrl", "seerrUrl"] as const) {
      if (body[key] === undefined) continue;
      const url = String(body[key]).trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return reply.code(400).send({ error: `${key === "jellyfinUrl" ? "Jellyfin" : "Seerr"} address must start with http:// or https://` });
      patch[key] = url;
    }
    for (const key of ["jellyfinApiKey", "seerrApiKey"] as const) {
      if (typeof body[key] === "string" && body[key]) patch[key] = String(body[key]).trim();
      if (body[key] === null) patch[key] = "";
    }
    if (Array.isArray(body.libraries)) patch.libraries = body.libraries.map(String);
    if (body.syncIntervalMinutes !== undefined) {
      const n = Number(body.syncIntervalMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 1440) return reply.code(400).send({ error: "Sync interval must be 1–1440 minutes" });
      patch.syncIntervalMinutes = Math.round(n);
    }
    if (typeof body.tagChildren === "boolean") patch.tagChildren = body.tagChildren;
    if (typeof body.watchSuggestions === "boolean") patch.watchSuggestions = body.watchSuggestions;
    if (body.unrequestedAction === "none" || body.unrequestedAction === "tag") patch.unrequestedAction = body.unrequestedAction;
    if (Array.isArray(body.unrequestedPeople)) patch.unrequestedPeople = body.unrequestedPeople.map(Number).filter(Number.isFinite);
    if (body.unrequestedGraceHours !== undefined) {
      const n = Number(body.unrequestedGraceHours);
      if (!Number.isFinite(n) || n < 0 || n > 24 * 365) return reply.code(400).send({ error: "Grace period must be 0 or more hours" });
      patch.unrequestedGraceHours = n;
    }
    if (Array.isArray(body.ignoredSeerrUsers)) {
      patch.ignoredSeerrUsers = [...new Set(body.ignoredSeerrUsers.map(Number).filter(Number.isInteger))];
    }
    if (typeof body.setupComplete === "boolean") patch.setupComplete = body.setupComplete;
    if (body.rotateWebhook === true) patch.webhookSecret = randomSecret();
    if (patch.tagChildren === true) db.exec("UPDATE items SET children_synced = NULL");
    saveSettings(db, patch);
    if (["jellyfinUrl", "jellyfinApiKey", "seerrUrl", "seerrApiKey", "libraries", "unrequestedAction", "unrequestedPeople", "tagChildren"].some((k) => k in patch)) {
      engine.poke("settings changed");
    }
    return { ok: true };
  });

  app.post<{ Body: { url?: string; apiKey?: string } }>("/api/test/jellyfin", async (req, reply) => {
    const s = getSettings(db);
    const url = String(req.body?.url ?? s.jellyfinUrl).trim();
    const key = String(req.body?.apiKey || s.jellyfinApiKey);
    if (!url || !key) return reply.code(400).send({ error: "Enter the address and an API key" });
    try {
      const jf = new Jellyfin(url, key);
      const info = await jf.info();
      const users = await jf.users();
      const libraries = await jf.libraries();
      return {
        ok: true,
        serverName: info.ServerName,
        version: info.Version,
        users: users.length,
        libraries: libraries.map((l) => ({ id: l.ItemId, name: l.Name, type: l.CollectionType ?? "mixed" })),
      };
    } catch (err) {
      return reply.code(502).send({ error: friendlyConnectionError("Jellyfin", err) });
    }
  });

  app.post<{ Body: { url?: string; apiKey?: string } }>("/api/test/seerr", async (req, reply) => {
    const s = getSettings(db);
    const url = String(req.body?.url ?? s.seerrUrl).trim();
    const key = String(req.body?.apiKey || s.seerrApiKey);
    if (!url || !key) return reply.code(400).send({ error: "Enter the address and an API key" });
    try {
      const res = await new Seerr(url, key).test();
      return { ok: true, version: res.version, users: res.users };
    } catch (err) {
      return reply.code(502).send({ error: friendlyConnectionError("Seerr", err) });
    }
  });

  app.get("/api/libraries", async (_req, reply) => {
    const jf = engine.jellyfin();
    if (!jf) return [];
    try {
      return (await jf.libraries()).map((l) => ({ id: l.ItemId, name: l.Name, type: l.CollectionType ?? "mixed" }));
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  // --- Access (Jellyfin parental-control tags) -------------------------------------------

  app.get("/api/access", async (_req, reply) => {
    const jf = engine.jellyfin();
    if (!jf) return { users: [], version: null };
    try {
      const [users, info] = await Promise.all([jf.users(), jf.info()]);
      const people = listPeople(db);
      const items = db.prepare("SELECT tags FROM items").all() as { tags: string }[];
      const total = items.length;
      return {
        version: info.Version,
        total,
        users: users.map((u) => {
          const allowed = u.Policy?.AllowedTags ?? [];
          const blocked = u.Policy?.BlockedTags ?? [];
          const visible = items.filter((i) => {
            const tags = JSON.parse(i.tags) as string[];
            if (blocked.some((b) => hasTag(tags, b))) return false;
            return !allowed.length || allowed.some((a) => hasTag(tags, a));
          }).length;
          return {
            id: u.Id,
            name: u.Name,
            isAdmin: !!u.Policy?.IsAdministrator,
            allowedTags: allowed,
            blockedTags: blocked,
            visible,
            personId: people.find((p) => p.jellyfin_user_id === u.Id)?.id ?? null,
          };
        }),
      };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  app.post<{ Params: { userId: string }; Body: { allowedTags?: string[] } }>("/api/access/:userId", async (req, reply) => {
    const jf = engine.jellyfin();
    if (!jf) return reply.code(400).send({ error: "Jellyfin isn't connected" });
    const allowed = arrayOf(req.body?.allowedTags, "string").map((t) => t.trim()).filter(Boolean);
    try {
      const user = await jf.getUser(req.params.userId);
      if (!user.Policy) return reply.code(502).send({ error: "Jellyfin didn't return this user's policy" });
      await jf.setPolicy(user.Id, { ...user.Policy, AllowedTags: allowed });
      logActivity(
        db,
        "access",
        allowed.length ? `${user.Name} now sees items tagged ${allowed.map((t) => `“${t}”`).join(" or ")}` : `${user.Name} now sees everything`,
      );
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  // --- Frontend ----------------------------------------------------------------------------

  const webRoot = opts.webRoot;
  if (webRoot && fs.existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, maxAge: "1h" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  function getPerson(id: number): Person | undefined {
    return db.prepare("SELECT * FROM people WHERE id = ?").get(id) as unknown as Person | undefined;
  }

  function checkPerson(name: string, tag: string, selfId: number | null): string | null {
    if (!name) return "Give them a name";
    if (!tag) return "Choose a tag";
    if (tag.length > 100) return "That tag is too long";
    const clash = listPeople(db).find((p) => p.id !== selfId && p.tag.toLowerCase() === tag.toLowerCase());
    if (clash) return `${clash.name} already uses the tag “${clash.tag}”`;
    return null;
  }

  return { app, engine, updates };
}

interface SeasonBody {
  name?: string;
  start?: string;
  end?: string;
  yearly?: boolean;
  people?: number[];
  collection?: boolean;
  collectionName?: string | null;
  collectionGeneric?: boolean;
  itemIds?: string[];
}

/** What an image really is, from its first bytes (not what it claims). */
function imageType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface PersonBody {
  name?: string;
  tag?: string;
  color?: string;
  seerrUserId?: number | null;
  jellyfinUserId?: string | null;
}

function publicPerson(p: Person) {
  return { id: p.id, name: p.name, tag: p.tag, color: p.color, seerrUserId: p.seerr_user_id, jellyfinUserId: p.jellyfin_user_id };
}

function arrayOf(value: unknown, type: "string"): string[];
function arrayOf(value: unknown, type: "number"): number[];
function arrayOf(value: unknown, type: "string" | "number"): (string | number)[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === type) : [];
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function validColor(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

function friendlyConnectionError(service: string, err: unknown): string {
  const text = errorText(err);
  if (/→ 401|→ 403/.test(text)) return `${service} rejected the API key`;
  if (/ECONNREFUSED/.test(text)) return `Nothing answered at that address (connection refused). Check the host and port.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return `That host name doesn't resolve from the Tagarr container.`;
  if (/timed out/.test(text)) return `${service} didn't answer in time`;
  if (/→ 404/.test(text)) return `That address answered, but doesn't look like ${service}. Check the URL (and any base path).`;
  return text;
}
