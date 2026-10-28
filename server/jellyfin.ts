// A small Jellyfin API client: just what tagging needs. Works with an API key
// created in Dashboard → API Keys (an administrator key, so it can edit items
// and user policies).

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  SortName?: string;
  Type: string;
  ProductionYear?: number;
  ProviderIds?: Record<string, string>;
  Tags?: string[];
  DateCreated?: string;
  ImageTags?: Record<string, string>;
  ParentId?: string;
  SeriesId?: string;
  RecursiveItemCount?: number;
  ChildCount?: number;
  [key: string]: unknown;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: JellyfinPolicy;
}

export interface JellyfinPolicy {
  IsAdministrator?: boolean;
  AllowedTags?: string[];
  BlockedTags?: string[];
  [key: string]: unknown;
}

export interface JellyfinLibrary {
  Name: string;
  ItemId: string;
  CollectionType?: string;
}

const PAGE = 500;

export class Jellyfin {
  baseUrl: string;
  apiKey: string;
  private adminUserId: string | null = null;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `MediaBrowser Client="Tagarr", Device="Tagarr", DeviceId="tagarr", Version="1", Token="${this.apiKey}"`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `Jellyfin ${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`.trim());
    }
    if (res.status === 204) return undefined as T;
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("json") ? await res.json() : await res.text()) as T;
  }

  async info(): Promise<{ ServerName: string; Version: string }> {
    return this.request("GET", "/System/Info");
  }

  async users(): Promise<JellyfinUser[]> {
    return this.request("GET", "/Users");
  }

  /** Some endpoints need a user context; any administrator will do. */
  async getAdminUserId(): Promise<string> {
    if (this.adminUserId) return this.adminUserId;
    const users = await this.users();
    const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
    if (!admin) throw new Error("Jellyfin has no users");
    this.adminUserId = admin.Id;
    return admin.Id;
  }

  async libraries(): Promise<JellyfinLibrary[]> {
    const folders = await this.request<JellyfinLibrary[]>("GET", "/Library/VirtualFolders");
    return folders.filter((f) => !f.CollectionType || ["movies", "tvshows", "mixed"].includes(f.CollectionType));
  }

  /** Every movie and series, optionally limited to some libraries. */
  async allMedia(libraryIds: string[]): Promise<(JellyfinItem & { LibraryId?: string })[]> {
    const parents: (string | undefined)[] = libraryIds.length ? libraryIds : [undefined];
    const out: (JellyfinItem & { LibraryId?: string })[] = [];
    const seen = new Set<string>();
    const userId = await this.getAdminUserId();
    for (const parent of parents) {
      for (let start = 0; ; start += PAGE) {
        const q = new URLSearchParams({
          userId,
          Recursive: "true",
          IncludeItemTypes: "Movie,Series",
          Fields: "ProviderIds,Tags,DateCreated,SortName,RecursiveItemCount,ChildCount",
          EnableUserData: "false",
          EnableImageTypes: "Primary",
          ImageTypeLimit: "1",
          StartIndex: String(start),
          Limit: String(PAGE),
          SortBy: "SortName",
        });
        if (parent) q.set("ParentId", parent);
        const page = await this.request<{ Items: JellyfinItem[]; TotalRecordCount: number }>("GET", `/Items?${q}`);
        for (const item of page.Items) {
          if (seen.has(item.Id)) continue;
          seen.add(item.Id);
          out.push({ ...item, LibraryId: parent });
        }
        if (page.Items.length < PAGE || start + PAGE >= page.TotalRecordCount) break;
      }
    }
    return out;
  }

  /** Ids of items a user has played (movies) or started (series, via episodes). */
  async watchedBy(userId: string): Promise<{ movies: Set<string>; series: Set<string> }> {
    const movies = new Set<string>();
    const series = new Set<string>();
    for (const [types, filter] of [
      ["Movie", "IsPlayed"],
      ["Movie", "IsResumable"],
      ["Episode", "IsPlayed"],
      ["Episode", "IsResumable"],
    ] as const) {
      for (let start = 0; ; start += PAGE) {
        const q = new URLSearchParams({
          userId,
          Recursive: "true",
          IncludeItemTypes: types,
          Filters: filter,
          EnableUserData: "false",
          EnableImages: "false",
          StartIndex: String(start),
          Limit: String(PAGE),
        });
        const page = await this.request<{ Items: JellyfinItem[]; TotalRecordCount: number }>("GET", `/Items?${q}`);
        for (const item of page.Items) {
          if (types === "Movie") movies.add(item.Id);
          else if (item.SeriesId) series.add(item.SeriesId);
        }
        if (page.Items.length < PAGE || start + PAGE >= page.TotalRecordCount) break;
      }
    }
    return { movies, series };
  }

  /** The full item, as the edit endpoint wants it back. */
  async getItem(itemId: string): Promise<JellyfinItem> {
    const userId = await this.getAdminUserId();
    try {
      return await this.request<JellyfinItem>("GET", `/Items/${itemId}?userId=${userId}`);
    } catch (err) {
      // Jellyfin before 10.9 only has the per-user route.
      if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
        return this.request<JellyfinItem>("GET", `/Users/${userId}/Items/${itemId}`);
      }
      throw err;
    }
  }

  /**
   * Adds and removes tags on one item, leaving every other tag and field as it
   * is. Returns the item's tags afterwards. Tags compare case-insensitively,
   * like Jellyfin's own parental-control filtering.
   */
  async editTags(itemId: string, add: string[], remove: string[]): Promise<string[]> {
    const item = await this.getItem(itemId);
    const current = item.Tags ?? [];
    const next = applyTagEdit(current, add, remove);
    if (sameTags(current, next)) return current;
    await this.request("POST", `/Items/${itemId}`, { ...editableFields(item), Tags: next });
    return next;
  }

  async rename(itemId: string, name: string) {
    const item = await this.getItem(itemId);
    if (item.Name === name) return;
    await this.request("POST", `/Items/${itemId}`, { ...editableFields(item), Name: name });
  }

  // --- Collections (BoxSets) ---

  /** The collection with exactly this name, if there is one. */
  async findCollection(name: string): Promise<JellyfinItem | null> {
    const userId = await this.getAdminUserId();
    const q = new URLSearchParams({ userId, Recursive: "true", IncludeItemTypes: "BoxSet", SearchTerm: name, EnableImages: "false" });
    const page = await this.request<{ Items: JellyfinItem[] }>("GET", `/Items?${q}`);
    return page.Items.find((i) => i.Name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  async createCollection(name: string, itemIds: string[]): Promise<string> {
    const q = new URLSearchParams({ Name: name, Ids: itemIds.slice(0, 50).join(",") });
    const res = await this.request<{ Id: string }>("POST", `/Collections?${q}`);
    if (itemIds.length > 50) await this.addToCollection(res.Id, itemIds.slice(50));
    return res.Id;
  }

  /** The collection itself, or null when it's been deleted. */
  async getCollection(collectionId: string): Promise<JellyfinItem | null> {
    try {
      return await this.getItem(collectionId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Unlinks an item from online metadata and locks it, so Jellyfin stops
   * looking it up: provider ids, the downloaded overview and downloaded
   * artwork go, then a refresh lets Jellyfin draw its own poster (for a
   * collection, a collage of what's in it).
   */
  async makeGeneric(item: JellyfinItem, opts: { refresh: boolean }) {
    const wasMatched = Object.values(item.ProviderIds ?? {}).some(Boolean);
    await this.request("POST", `/Items/${item.Id}`, {
      ...editableFields(item),
      ProviderIds: {},
      LockData: true,
      ...(wasMatched ? { Overview: "" } : {}),
    });
    if (!wasMatched) return;
    await this.deleteImages(item);
    if (!opts.refresh) return;
    const q = new URLSearchParams({ MetadataRefreshMode: "Default", ImageRefreshMode: "FullRefresh", ReplaceAllImages: "true", ReplaceAllMetadata: "false" });
    await this.request("POST", `/Items/${item.Id}/Refresh?${q}`);
  }

  /** Removes an item's artwork (all of it, or just these types). */
  async deleteImages(item: JellyfinItem, only?: string[]) {
    const images = [
      ...Object.keys((item.ImageTags as Record<string, string> | undefined) ?? {}),
      ...((item.BackdropImageTags as string[] | undefined)?.length ? ["Backdrop"] : []),
    ];
    for (const type of new Set(images)) {
      if (only && !only.includes(type)) continue;
      try {
        await this.request("DELETE", `/Items/${item.Id}/Images/${type}`);
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    }
  }

  /** Asks Jellyfin to redraw an item's own artwork (a collection's collage). */
  async refreshImages(itemId: string) {
    const q = new URLSearchParams({ MetadataRefreshMode: "None", ImageRefreshMode: "FullRefresh", ReplaceAllImages: "true", ReplaceAllMetadata: "false" });
    await this.request("POST", `/Items/${itemId}/Refresh?${q}`);
  }

  /** Sets an item's poster. Jellyfin takes the image base64-encoded, typed as the image. */
  async uploadImage(itemId: string, type: "Primary", mime: string, data: Uint8Array) {
    const res = await fetch(`${this.baseUrl}/Items/${itemId}/Images/${type}`, {
      method: "POST",
      headers: {
        Authorization: `MediaBrowser Client="Tagarr", Device="Tagarr", DeviceId="tagarr", Version="1", Token="${this.apiKey}"`,
        "Content-Type": mime,
      },
      body: Buffer.from(data).toString("base64"),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `Jellyfin POST /Items/{id}/Images/${type} → ${res.status} ${text.slice(0, 200)}`.trim());
    }
  }

  /** Ids of what's in a collection. */
  async collectionItems(collectionId: string): Promise<string[]> {
    const userId = await this.getAdminUserId();
    const q = new URLSearchParams({ userId, ParentId: collectionId, EnableImages: "false", EnableUserData: "false" });
    const page = await this.request<{ Items: JellyfinItem[] }>("GET", `/Items?${q}`);
    return page.Items.map((i) => i.Id);
  }

  async addToCollection(collectionId: string, itemIds: string[]) {
    for (let i = 0; i < itemIds.length; i += 50) {
      await this.request("POST", `/Collections/${collectionId}/Items?Ids=${itemIds.slice(i, i + 50).join(",")}`);
    }
  }

  async removeFromCollection(collectionId: string, itemIds: string[]) {
    for (let i = 0; i < itemIds.length; i += 50) {
      await this.request("DELETE", `/Collections/${collectionId}/Items?Ids=${itemIds.slice(i, i + 50).join(",")}`);
    }
  }

  /** Deletes an item from Jellyfin. Only used for collections Tagarr made. */
  async deleteItem(itemId: string) {
    try {
      await this.request("DELETE", `/Items/${itemId}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return;
      throw err;
    }
  }

  /** Seasons and episodes under a series (for tagChildren). */
  async children(seriesId: string): Promise<JellyfinItem[]> {
    const userId = await this.getAdminUserId();
    const q = new URLSearchParams({
      userId,
      ParentId: seriesId,
      Recursive: "true",
      IncludeItemTypes: "Season,Episode",
      Fields: "Tags",
      EnableImages: "false",
      EnableUserData: "false",
    });
    const page = await this.request<{ Items: JellyfinItem[] }>("GET", `/Items?${q}`);
    return page.Items;
  }

  async getUser(userId: string): Promise<JellyfinUser> {
    return this.request("GET", `/Users/${userId}`);
  }

  async setPolicy(userId: string, policy: JellyfinPolicy) {
    await this.request("POST", `/Users/${userId}/Policy`, policy);
  }

  async image(itemId: string, maxHeight: number): Promise<Response> {
    return fetch(`${this.baseUrl}/Items/${itemId}/Images/Primary?fillHeight=${maxHeight}&quality=85`, {
      headers: { Authorization: `MediaBrowser Token="${this.apiKey}"` },
      signal: AbortSignal.timeout(30_000),
    });
  }
}

// The fields Jellyfin's item editor (POST /Items/{id}) reads back, taken from
// its ItemUpdateController. Sending the whole item fails on fields it can't
// read back (a 500 on any item with trickplay images: TrickplayInfoDto has no
// deserialization constructor), and the scalar fields here are overwritten
// with whatever is sent, so each must be passed through unchanged.
// People is left out on purpose: when it's absent Jellyfin keeps the cast as
// it is; when it's sent, Jellyfin rewrites the whole cast and crew.
const EDITABLE_FIELDS = [
  "AirDays", "AirTime", "AirsAfterSeasonNumber", "AirsBeforeEpisodeNumber", "AirsBeforeSeasonNumber",
  "Album", "AlbumArtists", "ArtistItems", "AspectRatio", "CommunityRating", "CriticRating", "CustomRating",
  "DateCreated", "DisplayOrder", "EndDate", "ForcedSortName", "Genres", "Height", "IndexNumber", "LockData",
  "LockedFields", "Name", "OfficialRating", "OriginalLanguage", "OriginalTitle", "Overview", "ParentIndexNumber",
  "PreferredMetadataCountryCode", "PreferredMetadataLanguage", "PremiereDate", "ProductionLocations",
  "ProductionYear", "ProviderIds", "RunTimeTicks", "SeriesName", "Status", "Studios", "Taglines", "Tags",
  "Video3DFormat",
];

export function editableFields(item: JellyfinItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) if (key in item) out[key] = item[key];
  return out;
}

export function applyTagEdit(current: string[], add: string[], remove: string[]): string[] {
  const removeSet = new Set(remove.map((t) => t.toLowerCase()));
  const next = current.filter((t) => !removeSet.has(t.toLowerCase()));
  for (const tag of add) {
    if (!next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
  }
  return next;
}

export function sameTags(a: string[], b: string[]) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function hasTag(tags: string[], tag: string) {
  const lower = tag.toLowerCase();
  return tags.some((t) => t.toLowerCase() === lower);
}
