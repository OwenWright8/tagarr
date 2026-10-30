// Typed access to the server's /api. Errors carry the server's message.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/account")) {
      window.dispatchEvent(new Event("tagarr:signed-out"));
    }
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);

// --- Shapes ----------------------------------------------------------------------

export interface Session {
  authenticated: boolean;
  needsAccount: boolean;
  setupComplete: boolean;
  version: string;
}

export interface Person {
  id: number;
  name: string;
  tag: string;
  color: string;
  seerrUserId: number | null;
  jellyfinUserId: string | null;
  count?: number;
  onlyCount?: number;
}

export interface Item {
  id: string;
  type: "Movie" | "Series";
  name: string;
  year: number | null;
  dateCreated: string | null;
  hasImage: boolean;
  people: { id: number; source: string }[];
  suggested: number[];
  requestedBy: string[];
  otherTags: string[];
  seasons: { id: number; name: string; active: boolean; people: number[] }[];
}

export interface Season {
  id: number;
  name: string;
  /** Server-local wall time, "YYYY-MM-DDTHH:mm" (the year is ignored when yearly). */
  start: string;
  end: string;
  yearly: boolean;
  people: number[];
  collection: boolean;
  collectionName: string | null;
  collectionMade: boolean;
  collectionGeneric: boolean;
  coverVersion: number | null;
  itemCount: number;
  /** Titles in the season that aren't in Jellyfin right now (they rejoin when they're back). */
  missingCount: number;
  /** The current window, or the next one. */
  status: { active: boolean; over: boolean; start: string; end: string };
  applied: boolean;
}

export interface SeasonDetail extends Season {
  items: { id: string; name: string; year: number | null; type: "Movie" | "Series"; hasImage: boolean }[];
}

export interface SyncStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  error: string | null;
  reason: string | null;
  nextAt: number | null;
  stats: {
    items: number;
    tagged: number;
    adopted: number;
    fromRequests: number;
    fromRule: number;
    seasonal: number;
    pendingRequests: number;
    suggestions: number;
    errors: number;
  } | null;
}

export interface Activity {
  id: number;
  at: number;
  kind: "tagged" | "untagged" | "adopted" | "error" | "sync" | "access" | "season";
  message: string;
  item_id: string | null;
  person_id: number | null;
}

export interface Overview {
  connections: { jellyfin: boolean; seerr: boolean };
  totals: {
    items: number;
    movies: number;
    shows: number;
    untagged: number;
    seasonal: number;
    shared: number;
    pendingRequests: number;
    unmappedRequests: number;
    suggestions: number;
  };
  seasons: Season[];
  people: (Person & { count: number; onlyCount: number })[];
  activity: Activity[];
  sync: SyncStatus;
}

export interface SettingsData {
  jellyfinUrl: string;
  jellyfinApiKeySet: boolean;
  seerrUrl: string;
  seerrApiKeySet: boolean;
  libraries: string[];
  syncIntervalMinutes: number;
  tagChildren: boolean;
  watchSuggestions: boolean;
  unrequestedAction: "none" | "tag";
  unrequestedPeople: number[];
  unrequestedGraceHours: number;
  ignoredSeerrUsers: number[];
  webhookPath: string;
  adminUsername: string;
  setupComplete: boolean;
}

export interface RequestEntry {
  id: number;
  type: "movie" | "tv";
  title: string;
  year: number | null;
  requestedBy: string | null;
  seerrUserId: number | null;
  personId: number | null;
  createdAt: string | null;
  itemId: string | null;
  hasImage: boolean;
  state: "waiting" | "unlinked" | "ignored" | "tagged" | "queued" | "declined";
}

export interface Suggestion {
  itemId: string;
  personId: number;
  reason: string;
  name: string;
  year: number | null;
  type: string;
  hasImage: boolean;
}

export interface RemoteUsers {
  jellyfin: { id: string; name: string; isAdmin: boolean }[];
  seerr: { id: number; name: string; jellyfinUserId: string | null; requestCount: number }[];
  errors: string[];
}

export interface Library {
  id: string;
  name: string;
  type: string;
}

export interface AccessUser {
  id: string;
  name: string;
  isAdmin: boolean;
  allowedTags: string[];
  blockedTags: string[];
  visible: number;
  personId: number | null;
}

export interface About {
  version: string;
  repo: string;
  update: { enabled: boolean; latest: string | null; url: string | null; checkedAt: number | null };
  updateAvailable: boolean;
}
