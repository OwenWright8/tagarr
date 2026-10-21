// Fake Jellyfin and Seerr servers with a small demo library, for development,
// the integration tests and the README screenshots. Only the endpoints
// Tagarr uses are implemented, with the same shapes as the real APIs.
//
//   npm run dev:mock      # Jellyfin on :8096 (key "jellyfin-key"), Seerr on :5055 (key "seerr-key")
import http from "node:http";
import { fileURLToPath } from "node:url";

export const JELLYFIN_KEY = "jellyfin-key";
export const SEERR_KEY = "seerr-key";

interface MockItem {
  Id: string;
  Name: string;
  Type: "Movie" | "Series" | "Season" | "Episode";
  ProductionYear?: number;
  ProviderIds: Record<string, string>;
  Tags: string[];
  DateCreated: string;
  ParentId: string;
  SeriesId?: string;
  Overview?: string;
  Genres?: string[];
}

interface MockUser {
  Id: string;
  Name: string;
  Policy: { IsAdministrator: boolean; AllowedTags: string[]; BlockedTags: string[]; EnableAllFolders: boolean };
  played: Set<string>;
}

const MOVIES_LIB = "f137a2dd21bbc1b99aa5c0f6bf02a805";
const SHOWS_LIB = "a656b907eb3a73532e40e44b968d0225";

// [title, year, type, tmdb, tags already in Jellyfin, days since added]
const DEMO: [string, number, "Movie" | "Series", number, string[], number][] = [
  ["Dune: Part Two", 2024, "Movie", 693134, [], 1],
  ["Past Lives", 2023, "Movie", 666277, [], 2],
  ["Wicked", 2024, "Movie", 402431, [], 3],
  ["Severance", 2022, "Series", 95396, [], 3],
  ["The Bear", 2022, "Series", 136315, [], 4],
  ["Inside Out 2", 2024, "Movie", 1022789, [], 5],
  ["Shōgun", 2024, "Series", 126308, [], 6],
  ["Gilmore Girls", 2000, "Series", 4586, ["Alex"], 9],
  ["Oppenheimer", 2023, "Movie", 872585, ["Owen"], 10],
  ["Abbott Elementary", 2021, "Series", 125935, [], 12],
  ["Spider-Man: Across the Spider-Verse", 2023, "Movie", 569094, ["Owen", "Alex"], 14],
  ["Bluey", 2018, "Series", 82728, ["Jamie"], 15],
  ["Arcane", 2021, "Series", 94605, [], 18],
  ["Everything Everywhere All at Once", 2022, "Movie", 545611, ["Owen", "Alex"], 20],
  ["Pride & Prejudice", 2005, "Movie", 4348, ["Alex"], 22],
  ["Andor", 2022, "Series", 83867, ["Owen"], 25],
  ["Little Women", 2019, "Movie", 331482, [], 26],
  ["Ted Lasso", 2020, "Series", 97546, ["Owen", "Alex"], 30],
  ["The Grand Budapest Hotel", 2014, "Movie", 120467, [], 33],
  ["Coco", 2017, "Movie", 354912, ["Jamie", "Alex"], 35],
  ["Arrival", 2016, "Movie", 329865, ["Owen"], 40],
  ["The Great British Bake Off", 2010, "Series", 87012, ["Alex"], 41],
  ["Mad Max: Fury Road", 2015, "Movie", 76341, ["Owen"], 44],
  ["Only Murders in the Building", 2021, "Series", 107113, ["Alex", "Owen"], 47],
  ["Paddington 2", 2017, "Movie", 346648, ["Jamie", "Owen", "Alex"], 50],
  ["Breaking Bad", 2008, "Series", 1396, ["Owen"], 52],
  ["La La Land", 2016, "Movie", 313369, ["Alex"], 55],
  ["Brooklyn Nine-Nine", 2013, "Series", 48891, [], 60],
  ["Knives Out", 2019, "Movie", 546554, ["Owen", "Alex"], 62],
  ["Interstellar", 2014, "Movie", 157336, ["Owen"], 70],
  ["Stranger Things", 2016, "Series", 66732, ["Owen", "Jamie"], 75],
  ["Top Gun: Maverick", 2022, "Movie", 361743, ["Owen"], 80],
  ["Barbie", 2023, "Movie", 346698, ["Alex"], 90],
  ["The Office", 2005, "Series", 2316, [], 100],
  ["Succession", 2018, "Series", 76331, ["Owen"], 110],
  ["The Batman", 2022, "Movie", 414906, ["Owen"], 120],
];

// Seerr users and who requested what. Seerr user 3 isn't linked to anyone yet in the demo.
const SEERR_USERS = [
  { id: 1, displayName: "Owen", jellyfinUsername: "owen", jellyfinUserId: "u-owen", requestCount: 0 },
  { id: 2, displayName: "Alex", jellyfinUsername: "alex", jellyfinUserId: "u-alex", requestCount: 0 },
  { id: 3, displayName: "Jamie", jellyfinUsername: "jamie", jellyfinUserId: "u-jamie", requestCount: 0 },
];
// [tmdb, type, seerr user, status]
const REQUESTS: [number, "movie" | "tv", number, number][] = [
  [693134, "movie", 1, 5], // Dune: Part Two — Owen
  [666277, "movie", 2, 5], // Past Lives — Alex
  [402431, "movie", 2, 5], // Wicked — Alex
  [95396, "tv", 1, 5], // Severance — Owen
  [95396, "tv", 2, 5], // Severance — Alex too: shared
  [136315, "tv", 1, 5], // The Bear — Owen
  [1022789, "movie", 3, 5], // Inside Out 2 — Jamie
  [126308, "tv", 1, 5], // Shōgun — Owen
  [125935, "tv", 2, 5], // Abbott Elementary — Alex
  [94605, "tv", 1, 5], // Arcane — Owen
  [933260, "movie", 2, 2], // The Substance — Alex, approved, downloading
  [1184918, "movie", 1, 2], // The Wild Robot — Owen, approved, downloading
  [119051, "tv", 2, 1], // Wednesday — Alex, pending approval
];
const NOT_YET: Record<number, { title: string; year: number }> = {
  933260: { title: "The Substance", year: 2024 },
  1184918: { title: "The Wild Robot", year: 2024 },
  119051: { title: "Wednesday", year: 2022 },
};

function hex(n: number) {
  return n.toString(16).padStart(32, "0").slice(-32);
}

export interface MockState {
  items: Map<string, MockItem>;
  users: MockUser[];
  requests: typeof REQUESTS;
  edits: number;
  addMovie(name: string, tmdb: number, year: number): MockItem;
  close(): Promise<void>;
  jellyfinUrl: string;
  seerrUrl: string;
}

export async function startMocks(opts: { jellyfinPort?: number; seerrPort?: number; demoTags?: boolean } = {}): Promise<MockState> {
  const items = new Map<string, MockItem>();
  const now = Date.now();
  let counter = 1;
  const add = (item: Omit<MockItem, "Id">) => {
    const id = hex(0xa000 + counter++);
    const full = { ...item, Id: id };
    items.set(id, full);
    return full;
  };
  for (const [name, year, type, tmdb, tags, days] of DEMO) {
    const parent = add({
      Name: name,
      Type: type,
      ProductionYear: year,
      ProviderIds: type === "Series" ? { Tmdb: String(tmdb), Tvdb: String(tmdb + 300000) } : { Tmdb: String(tmdb), Imdb: `tt${tmdb}` },
      Tags: opts.demoTags === false ? [] : [...tags, ...(name === "Oppenheimer" ? ["IMAX"] : [])],
      DateCreated: new Date(now - days * 86_400_000).toISOString(),
      ParentId: type === "Movie" ? MOVIES_LIB : SHOWS_LIB,
      Overview: "",
    });
    if (type === "Series") {
      const season = add({ Name: "Season 1", Type: "Season", ProviderIds: {}, Tags: [], DateCreated: parent.DateCreated, ParentId: parent.Id, SeriesId: parent.Id });
      for (let e = 1; e <= 3; e++) {
        add({ Name: `Episode ${e}`, Type: "Episode", ProviderIds: {}, Tags: [], DateCreated: parent.DateCreated, ParentId: season.Id, SeriesId: parent.Id });
      }
    }
  }

  const byName = (n: string) => [...items.values()].find((i) => i.Name === n)!;
  const policy = (admin: boolean) => ({ IsAdministrator: admin, AllowedTags: [] as string[], BlockedTags: [] as string[], EnableAllFolders: true });
  const users: MockUser[] = [
    { Id: "u-owen", Name: "owen", Policy: policy(true), played: new Set() },
    { Id: "u-alex", Name: "alex", Policy: policy(false), played: new Set() },
    { Id: "u-jamie", Name: "jamie", Policy: policy(false), played: new Set() },
  ];
  // Watch history behind the "suggestions" feature: Alex has watched two
  // untagged things, Owen one.
  const episodeOf = (series: string) => [...items.values()].find((i) => i.Type === "Episode" && i.SeriesId === byName(series).Id)!.Id;
  users[1].played.add(byName("Little Women").Id).add(episodeOf("Brooklyn Nine-Nine")).add(episodeOf("The Office"));
  users[0].played.add(byName("The Grand Budapest Hotel").Id).add(episodeOf("The Office"));

  const state: MockState = {
    items,
    users,
    requests: REQUESTS,
    edits: 0,
    jellyfinUrl: "",
    seerrUrl: "",
    addMovie(name, tmdb, year) {
      return add({ Name: name, Type: "Movie", ProductionYear: year, ProviderIds: { Tmdb: String(tmdb) }, Tags: [], DateCreated: new Date().toISOString(), ParentId: MOVIES_LIB });
    },
    close: async () => {},
  };

  const jellyfin = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body?: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body === undefined ? "" : type === "application/json" ? JSON.stringify(body) : String(body));
    };
    const imageRoute = url.pathname.match(/^\/Items\/([^/]+)\/Images\/Primary$/);
    if (imageRoute) {
      const item = items.get(imageRoute[1]);
      return item ? send(200, poster(item), "image/svg+xml") : send(404);
    }
    if (!String(req.headers.authorization ?? "").includes(`Token="${JELLYFIN_KEY}"`)) return send(401, "Unauthorized", "text/plain");
    const body = await readBody(req);
    const p = url.pathname;
    const q = url.searchParams;

    if (p === "/System/Info") return send(200, { ServerName: "Demo Jellyfin", Version: "10.11.2" });
    if (p === "/Users") return send(200, users.map(publicUser));
    if (p === "/Library/VirtualFolders") {
      return send(200, [
        { Name: "Movies", ItemId: MOVIES_LIB, CollectionType: "movies" },
        { Name: "TV Shows", ItemId: SHOWS_LIB, CollectionType: "tvshows" },
        { Name: "Music", ItemId: "music", CollectionType: "music" },
      ]);
    }
    let m = p.match(/^\/Users\/([^/]+)$/);
    if (m) {
      const u = users.find((x) => x.Id === m![1]);
      return u ? send(200, publicUser(u)) : send(404);
    }
    m = p.match(/^\/Users\/([^/]+)\/Policy$/);
    if (m && req.method === "POST") {
      const u = users.find((x) => x.Id === m![1]);
      if (!u) return send(404);
      u.Policy = { ...u.Policy, ...(JSON.parse(body) as MockUser["Policy"]) };
      return send(204);
    }
    if (p === "/Items") {
      const types = (q.get("IncludeItemTypes") ?? "").split(",").filter(Boolean);
      const parent = q.get("ParentId");
      const filter = q.get("Filters");
      const user = users.find((u) => u.Id === q.get("userId"));
      let list = [...items.values()].filter((i) => !types.length || types.includes(i.Type));
      if (parent) list = list.filter((i) => isUnder(i, parent));
      if (filter === "IsPlayed") list = list.filter((i) => user?.played.has(i.Id));
      if (filter === "IsResumable") list = [];
      if (user && !user.Policy.IsAdministrator && user.Policy.AllowedTags.length) {
        list = list.filter((i) => user.Policy.AllowedTags.some((t) => i.Tags.includes(t)));
      }
      list.sort((a, b) => a.Name.localeCompare(b.Name));
      const start = Number(q.get("StartIndex") ?? 0);
      const limit = Number(q.get("Limit") ?? 10000);
      const pageItems = list.slice(start, start + limit).map((i) => ({
        ...i,
        SortName: i.Name.replace(/^The /, "").toLowerCase(),
        ImageTags: { Primary: "x" },
        RecursiveItemCount: i.Type === "Series" ? [...items.values()].filter((c) => c.SeriesId === i.Id).length : undefined,
      }));
      return send(200, { Items: pageItems, TotalRecordCount: list.length });
    }
    m = p.match(/^\/Items\/([^/]+)$/);
    if (m) {
      const item = items.get(m[1]);
      if (!item) return send(404);
      if (req.method === "POST") {
        const next = JSON.parse(body) as MockItem;
        // Like Jellyfin, an edit replaces the item with what was sent.
        items.set(item.Id, { ...item, ...next, Id: item.Id });
        state.edits++;
        return send(204);
      }
      return send(200, { ...item, LockedFields: [], People: [], Studios: [] });
    }
    send(404, { error: "not implemented in mock" });
  });

  const isUnder = (item: MockItem, parent: string): boolean => {
    let cur: MockItem | undefined = item;
    for (let i = 0; cur && i < 5; i++) {
      if (cur.ParentId === parent) return true;
      cur = items.get(cur.ParentId);
    }
    return false;
  };

  const seerr = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = url.pathname;
    if (p === "/api/v1/status") return send(200, { version: "3.0.1" });
    if (req.headers["x-api-key"] !== SEERR_KEY) return send(403, { message: "Unauthorized" });
    const take = Number(url.searchParams.get("take") ?? 20);
    const skip = Number(url.searchParams.get("skip") ?? 0);
    const page = <T>(all: T[]) => send(200, { pageInfo: { pages: Math.ceil(all.length / take), page: skip / take + 1, results: all.length }, results: all.slice(skip, skip + take) });
    if (p === "/api/v1/user") {
      return page(SEERR_USERS.map((u) => ({ ...u, requestCount: state.requests.filter((r) => r[2] === u.id).length })));
    }
    if (p === "/api/v1/request") {
      return page(
        state.requests.map(([tmdb, type, userId, status], i) => {
          const item = [...items.values()].find((x) => x.ProviderIds.Tmdb === String(tmdb));
          return {
            id: i + 1,
            status,
            type,
            createdAt: new Date(Date.now() - (state.requests.length - i) * 3_600_000 * 20).toISOString(),
            media: {
              tmdbId: tmdb,
              tvdbId: type === "tv" ? tmdb + 300000 : undefined,
              mediaType: type,
              status: item ? 5 : 3,
              // Seerr only knows the Jellyfin id for some items; matching by TMDB covers the rest.
              jellyfinMediaId: item && i % 2 === 0 ? item.Id : null,
            },
            requestedBy: SEERR_USERS.find((u) => u.id === userId),
          };
        }),
      );
    }
    const m = p.match(/^\/api\/v1\/(movie|tv)\/(\d+)$/);
    if (m) {
      const t = NOT_YET[Number(m[2])] ?? { title: `TMDB ${m[2]}`, year: 2020 };
      return send(200, m[1] === "movie" ? { title: t.title, releaseDate: `${t.year}-01-01` } : { name: t.title, firstAirDate: `${t.year}-01-01` });
    }
    send(404, { message: "not implemented in mock" });
  });

  await new Promise<void>((r) => jellyfin.listen(opts.jellyfinPort ?? 0, "127.0.0.1", r));
  await new Promise<void>((r) => seerr.listen(opts.seerrPort ?? 0, "127.0.0.1", r));
  state.jellyfinUrl = `http://127.0.0.1:${(jellyfin.address() as { port: number }).port}`;
  state.seerrUrl = `http://127.0.0.1:${(seerr.address() as { port: number }).port}`;
  state.close = async () => {
    jellyfin.closeAllConnections();
    seerr.closeAllConnections();
    await Promise.all([new Promise((r) => jellyfin.close(r)), new Promise((r) => seerr.close(r))]);
  };
  return state;
}

function publicUser(u: MockUser) {
  return { Id: u.Id, Name: u.Name, Policy: u.Policy };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A simple generated poster: a gradient with the title set on it. */
function poster(item: MockItem): string {
  const h = hash(item.Name);
  const hue = h % 360;
  const hue2 = (hue + 40 + (h % 60)) % 360;
  const words = item.Name.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 12) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const size = lines.length > 3 ? 26 : 32;
  const text = lines
    .map((l, i) => `<text x="24" y="${330 - (lines.length - 1 - i) * (size + 4)}" font-size="${size}">${esc(l)}</text>`)
    .join("");
  const shape = h % 3 === 0
    ? `<circle cx="${120 + (h % 80)}" cy="${120 + (h % 50)}" r="${70 + (h % 40)}" fill="hsl(${hue2} 70% 70% / .35)"/>`
    : h % 3 === 1
      ? `<path d="M0 ${200 + (h % 60)} L240 ${120 + (h % 80)} L240 360 L0 360Z" fill="hsl(${hue2} 60% 65% / .3)"/>`
      : `<rect x="${30 + (h % 60)}" y="60" width="120" height="160" rx="60" fill="hsl(${hue2} 65% 70% / .3)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360" viewBox="0 0 240 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 45% 42%)"/><stop offset="1" stop-color="hsl(${hue2} 50% 16%)"/>
  </linearGradient></defs>
  <rect width="240" height="360" fill="url(#g)"/>${shape}
  <g font-family="Georgia, 'Times New Roman', serif" font-weight="700" fill="#fff">${text}</g>
  <text x="24" y="44" font-family="Helvetica, Arial, sans-serif" font-size="13" letter-spacing="3" fill="#fff" opacity=".75">${item.ProductionYear ?? ""}</text>
</svg>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startMocks({ jellyfinPort: 8096, seerrPort: 5055 });
  console.log(`Mock Jellyfin: ${s.jellyfinUrl}  (API key: ${JELLYFIN_KEY})`);
  console.log(`Mock Seerr:    ${s.seerrUrl}  (API key: ${SEERR_KEY})`);
}
