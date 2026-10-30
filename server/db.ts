// SQLite storage (Node's built-in node:sqlite, so there is no native module to
// build for each architecture). One file in the data volume holds everything:
// settings, people, the cached library, Seerr requests and the activity log.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

// Each entry runs once, in order, inside a transaction. Append only: never
// edit a migration that has shipped.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- A person is a tag. Linking a Seerr user makes their requests land on this
  -- tag; linking a Jellyfin user lets the app read their watch history and set
  -- their access rule. Both are optional (e.g. an "Everyone" or "Kids" tag).
  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT NOT NULL,
    seerr_user_id INTEGER,
    jellyfin_user_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX people_tag ON people (lower(tag));

  -- The movies and shows in Jellyfin, refreshed on every sync.
  CREATE TABLE items (
    id TEXT PRIMARY KEY,               -- Jellyfin item id
    type TEXT NOT NULL,                -- Movie | Series
    name TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    year INTEGER,
    tmdb_id TEXT,
    tvdb_id TEXT,
    imdb_id TEXT,
    library_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',   -- JSON: tags as Jellyfin has them now
    child_count INTEGER,
    children_synced INTEGER,           -- child_count when tags were last copied to children
    date_created TEXT,
    has_image INTEGER NOT NULL DEFAULT 0,
    rule_applied INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX items_tmdb ON items (tmdb_id);
  CREATE INDEX items_tvdb ON items (tvdb_id);

  -- Who an item belongs to. Source: request | manual | jellyfin (adopted from
  -- an existing tag) | watched (accepted suggestion) | rule (unrequested rule).
  CREATE TABLE assignments (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, person_id)
  );

  CREATE TABLE requests (
    id INTEGER PRIMARY KEY,            -- Seerr request id
    media_type TEXT NOT NULL,          -- movie | tv
    tmdb_id TEXT,
    tvdb_id TEXT,
    jellyfin_media_id TEXT,
    seerr_user_id INTEGER,
    requested_by TEXT,
    status INTEGER NOT NULL,
    title TEXT,
    year INTEGER,
    created_at TEXT,
    item_id TEXT,                      -- matched Jellyfin item, once it exists
    applied INTEGER NOT NULL DEFAULT 0 -- the requester's tag has been assigned
  );

  -- Items a person has watched but isn't tagged on.
  CREATE TABLE suggestions (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, person_id)
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- tagged | untagged | adopted | error | sync | access
    message TEXT NOT NULL,
    item_id TEXT,
    person_id INTEGER
  );
  CREATE INDEX activity_at ON activity (at DESC);
  `,
  `
  -- Keys for the read-only stats endpoint (Homepage's Custom API widget).
  -- Only a hash is stored: the key is shown once, when it's created.
  CREATE TABLE widget_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  `
  -- Seasonal titles: between start_at and end_at (local time, "YYYY-MM-DDTHH:mm";
  -- the year is ignored when yearly = 1) the season's items are tagged for its
  -- people, and outside it they carry nobody's tag. While an item is in a
  -- season, the season decides its people tags; its assignments are kept for
  -- when it leaves the season.
  CREATE TABLE seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    yearly INTEGER NOT NULL DEFAULT 1,
    people TEXT NOT NULL DEFAULT '[]',   -- JSON: person ids who see it in season
    collection INTEGER NOT NULL DEFAULT 0, -- keep a Jellyfin collection of the items
    collection_name TEXT,
    collection_id TEXT,                  -- the Jellyfin collection, once made
    applied_active INTEGER,              -- in season at the last apply (null: never applied)
    created_at INTEGER NOT NULL
  );

  CREATE TABLE season_items (
    season_id INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    PRIMARY KEY (season_id, item_id)
  );
  CREATE INDEX season_items_item ON season_items (item_id);
  `,
  `
  -- A season's collection is just a list of titles, not a film series: keep
  -- Jellyfin from matching it online by name (a "Halloween" collection would
  -- otherwise become TMDB's Halloween franchise, poster and all).
  ALTER TABLE seasons ADD COLUMN collection_generic INTEGER NOT NULL DEFAULT 1;

  -- A cover uploaded for the season, used as its collection's poster.
  -- cover_applied is "<version>|<Jellyfin image tag>" after the upload, so a
  -- poster replaced in Jellyfin (or a new cover here) is noticed and redone.
  CREATE TABLE season_covers (
    season_id INTEGER PRIMARY KEY REFERENCES seasons (id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data BLOB NOT NULL,
    version INTEGER NOT NULL
  );
  ALTER TABLE seasons ADD COLUMN cover_applied TEXT;
  `,
  `
  -- Season membership survives a title being replaced in Jellyfin (a new
  -- file can mean a new Jellyfin id): each row keeps the title's online ids
  -- so it can be found again, instead of being deleted with the old item.
  CREATE TABLE season_items_v2 (
    season_id INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,             -- the Jellyfin item (the last one seen, while it's missing)
    media_type TEXT,                   -- Movie | Series
    tmdb_id TEXT,
    tvdb_id TEXT,
    PRIMARY KEY (season_id, item_id)
  );
  INSERT INTO season_items_v2 (season_id, item_id, media_type, tmdb_id, tvdb_id)
    SELECT si.season_id, si.item_id, i.type, i.tmdb_id, i.tvdb_id
    FROM season_items si LEFT JOIN items i ON i.id = si.item_id;
  DROP TABLE season_items;
  ALTER TABLE season_items_v2 RENAME TO season_items;
  CREATE INDEX season_items_item ON season_items (item_id);

  -- Titles that left every season and still need their usual tags put back
  -- (kept until Jellyfin accepts the change, so an outage can't strand them).
  CREATE TABLE season_releases (
    item_id TEXT PRIMARY KEY,
    since INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// --- Settings ------------------------------------------------------------------

export interface Settings {
  jellyfinUrl: string;
  jellyfinApiKey: string;
  seerrUrl: string;
  seerrApiKey: string;
  /** Library ids to manage; empty means every movie and show library. */
  libraries: string[];
  syncIntervalMinutes: number;
  /** Also write tags onto seasons and episodes (only needed on old Jellyfin). */
  tagChildren: boolean;
  /** Read watch history to suggest tags for untagged items. */
  watchSuggestions: boolean;
  /** What to do with items nobody requested once the grace period passes. */
  unrequestedAction: "none" | "tag";
  unrequestedPeople: number[];
  unrequestedGraceHours: number;
  /** Seerr users whose requests are never tagged (e.g. an admin who sees everything). */
  ignoredSeerrUsers: number[];
  /** Jellyfin users who are meant to see everything, so aren't nagged about an access rule. */
  accessReminderDismissed: string[];
  webhookSecret: string;
  adminUsername: string;
  adminPasswordHash: string;
  setupComplete: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  jellyfinUrl: "",
  jellyfinApiKey: "",
  seerrUrl: "",
  seerrApiKey: "",
  libraries: [],
  syncIntervalMinutes: 15,
  tagChildren: false,
  watchSuggestions: true,
  unrequestedAction: "none",
  unrequestedPeople: [],
  unrequestedGraceHours: 24,
  ignoredSeerrUsers: [],
  accessReminderDismissed: [],
  webhookSecret: "",
  adminUsername: "",
  adminPasswordHash: "",
  setupComplete: false,
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = JSON.parse(row.value);
  }
  return out as unknown as Settings;
}

export function saveSettings(db: DB, patch: Partial<Settings>) {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
}

// --- Rows ----------------------------------------------------------------------

export interface Person {
  id: number;
  name: string;
  tag: string;
  color: string;
  seerr_user_id: number | null;
  jellyfin_user_id: string | null;
  created_at: number;
}

export interface ItemRow {
  id: string;
  type: "Movie" | "Series";
  name: string;
  sort_name: string;
  year: number | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  imdb_id: string | null;
  library_id: string | null;
  tags: string;
  child_count: number | null;
  children_synced: number | null;
  date_created: string | null;
  has_image: number;
  rule_applied: number;
}

export interface SeasonRow {
  id: number;
  name: string;
  start_at: string;
  end_at: string;
  yearly: number;
  people: string;
  collection: number;
  collection_name: string | null;
  collection_id: string | null;
  collection_generic: number;
  cover_applied: string | null;
  applied_active: number | null;
  created_at: number;
}

export function listSeasons(db: DB): SeasonRow[] {
  return db.prepare("SELECT * FROM seasons ORDER BY created_at, id").all() as unknown as SeasonRow[];
}

export function seasonPeople(season: Pick<SeasonRow, "people">): number[] {
  try {
    const ids = JSON.parse(season.people);
    return Array.isArray(ids) ? ids.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

export function listPeople(db: DB): Person[] {
  return db.prepare("SELECT * FROM people ORDER BY created_at, id").all() as unknown as Person[];
}

export function logActivity(
  db: DB,
  kind: string,
  message: string,
  refs: { itemId?: string | null; personId?: number | null } = {},
) {
  // The same failure on every sync would bury everything else: log a repeated
  // error once, and again only if it's still happening hours later.
  if (kind === "error") {
    const recent = db
      .prepare("SELECT 1 FROM activity WHERE kind = 'error' AND message = ? AND at > ? LIMIT 1")
      .get(message, Date.now() - 6 * 3_600_000);
    if (recent) return;
  }
  db.prepare("INSERT INTO activity (at, kind, message, item_id, person_id) VALUES (?, ?, ?, ?, ?)").run(
    Date.now(),
    kind,
    message,
    refs.itemId ?? null,
    refs.personId ?? null,
  );
  // Keep the log bounded: the newest 2000 entries are plenty for a UI.
  db.prepare("DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 2000)").run();
}
