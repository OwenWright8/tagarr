// Seerr (and Jellyseerr / Overseerr, which share its API) client: users,
// requests, and titles for requests that aren't in Jellyfin yet.
import { HttpError } from "./jellyfin.ts";

export interface SeerrUser {
  id: number;
  displayName?: string;
  username?: string;
  jellyfinUsername?: string;
  plexUsername?: string;
  jellyfinUserId?: string;
  email?: string;
  avatar?: string;
  requestCount?: number;
}

export interface SeerrRequest {
  id: number;
  status: number; // 1 pending, 2 approved, 3 declined, 4 failed, 5 completed
  type: "movie" | "tv";
  createdAt: string;
  media: {
    tmdbId?: number;
    tvdbId?: number;
    mediaType: "movie" | "tv";
    status?: number;
    jellyfinMediaId?: string | null;
    jellyfinMediaId4k?: string | null;
  };
  requestedBy?: SeerrUser;
}

interface Page<T> {
  pageInfo: { pages: number; page: number; results: number };
  results: T[];
}

export const REQUEST_DECLINED = 3;

export class Seerr {
  baseUrl: string;
  apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async request<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + "/api/v1" + path, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `Seerr ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`.trim());
    }
    return (await res.json()) as T;
  }

  async status(): Promise<{ version: string }> {
    return this.request("/status");
  }

  /** Checks the key too: /status answers without one. */
  async test(): Promise<{ version: string; users: number }> {
    const status = await this.status();
    const users = await this.request<Page<SeerrUser>>("/user?take=1");
    return { version: status.version, users: users.pageInfo.results };
  }

  async users(): Promise<SeerrUser[]> {
    return this.paged<SeerrUser>("/user", "");
  }

  async requests(): Promise<SeerrRequest[]> {
    return this.paged<SeerrRequest>("/request", "&filter=all&sort=added");
  }

  async title(type: "movie" | "tv", tmdbId: string): Promise<{ title: string; year: number | null }> {
    const data = await this.request<{ title?: string; name?: string; releaseDate?: string; firstAirDate?: string }>(
      `/${type}/${encodeURIComponent(tmdbId)}`,
    );
    const date = data.releaseDate || data.firstAirDate || "";
    return { title: data.title || data.name || `TMDB ${tmdbId}`, year: date ? Number(date.slice(0, 4)) || null : null };
  }

  private async paged<T>(path: string, extra: string): Promise<T[]> {
    const take = 100;
    const out: T[] = [];
    for (let skip = 0; ; skip += take) {
      const page = await this.request<Page<T>>(`${path}?take=${take}&skip=${skip}${extra}`);
      out.push(...page.results);
      if (page.results.length < take || out.length >= page.pageInfo.results) break;
    }
    return out;
  }
}

export function seerrUserName(u: SeerrUser | undefined): string {
  if (!u) return "Unknown";
  return u.displayName || u.jellyfinUsername || u.username || u.plexUsername || u.email || `User ${u.id}`;
}
