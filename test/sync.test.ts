// End to end: the real app and sync engine against the fake Jellyfin and Seerr
// in scripts/mock-servers.ts, driven through the HTTP API like the UI does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import type { Engine } from "../server/engine.ts";
import { JELLYFIN_KEY, SEERR_KEY, startMocks, type MockState } from "../scripts/mock-servers.ts";

let mock: MockState;
let app: FastifyInstance;
let engine: Engine;
let cookie = "";
let database: ReturnType<typeof openDb>;
const db = () => database;

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers["set-cookie"];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const tagsOf = (name: string) => [...mock.items.values()].find((i) => i.Name === name)!.Tags;
const idOf = (name: string) => [...mock.items.values()].find((i) => i.Name === name)!.Id;

before(async () => {
  mock = await startMocks();
  database = openDb(":memory:");
  ({ app, engine } = await buildApp({ db: database, version: "v1.0.0", repo: "x/y", updateCheck: false }));
});

after(async () => {
  engine.stop();
  await app.close();
  await mock.close();
});

test("first visit creates the account; the API needs a session", async () => {
  assert.equal((await api("GET", "/api/overview")).status, 401);
  const session = await api("GET", "/api/session");
  assert.equal(session.json.needsAccount, true);
  assert.equal((await api("POST", "/api/account/create", { username: "owen", password: "short" })).status, 400);
  assert.equal((await api("POST", "/api/account/create", { username: "owen", password: "correct horse" })).status, 200);
  assert.equal((await api("GET", "/api/overview")).status, 200);
  // A second account can't be created.
  assert.equal((await api("POST", "/api/account/create", { username: "eve", password: "12345678" })).status, 409);
});

test("rejects form posts (CSRF) and bad sign-ins", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/sync",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: "a=b",
  });
  assert.equal(res.statusCode, 415);
  const saved = cookie;
  cookie = "";
  assert.equal((await api("POST", "/api/login", { username: "owen", password: "nope" })).status, 401);
  assert.equal((await api("POST", "/api/login", { username: "Owen", password: "correct horse" })).status, 200);
  cookie = saved;
});

test("connection tests report bad keys clearly", async () => {
  const bad = await api("POST", "/api/test/jellyfin", { url: mock.jellyfinUrl, apiKey: "wrong" });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /rejected the API key/);
  const good = await api("POST", "/api/test/jellyfin", { url: mock.jellyfinUrl, apiKey: JELLYFIN_KEY });
  assert.equal(good.json.serverName, "Demo Jellyfin");
  assert.deepEqual(good.json.libraries.map((l: { name: string }) => l.name), ["Movies", "TV Shows"]);
  const seerr = await api("POST", "/api/test/seerr", { url: mock.seerrUrl, apiKey: SEERR_KEY });
  assert.equal(seerr.json.users, 3);
});

test("requests are tagged with the requester, existing tags are adopted", async () => {
  await api("PUT", "/api/settings", {
    jellyfinUrl: mock.jellyfinUrl + "/",
    jellyfinApiKey: JELLYFIN_KEY,
    seerrUrl: mock.seerrUrl,
    seerrApiKey: SEERR_KEY,
  });
  const owen = await api("POST", "/api/people", { name: "Owen", tag: "Owen", seerrUserId: 1, jellyfinUserId: "u-owen" });
  const alex = await api("POST", "/api/people", { name: "Alex", tag: "Alex", seerrUserId: 2, jellyfinUserId: "u-alex" });
  // Jamie exists as a tag but isn't linked to Seerr yet.
  await api("POST", "/api/people", { name: "Jamie", tag: "Jamie" });
  assert.equal((await api("POST", "/api/people", { name: "Dup", tag: "owen" })).status, 400);
  assert.ok(owen.json.id && alex.json.id);

  await engine.sync("test");
  assert.equal(engine.status.ok, true, engine.status.error ?? "");

  assert.deepEqual(tagsOf("Dune: Part Two"), ["Owen"]);
  assert.deepEqual(tagsOf("Past Lives"), ["Alex"]);
  // Both requested it, so it shows for both.
  assert.deepEqual(tagsOf("Severance").sort(), ["Alex", "Owen"]);
  // Unlinked requester: nothing yet.
  assert.deepEqual(tagsOf("Inside Out 2"), []);
  // Other tags are left alone.
  assert.deepEqual(tagsOf("Oppenheimer"), ["Owen", "IMAX"]);

  const overview = (await api("GET", "/api/overview")).json;
  assert.equal(overview.totals.pendingRequests, 3);
  assert.equal(overview.totals.unmappedRequests, 1);
  const gilmore = (await api("GET", "/api/items?q=gilmore")).json.items[0];
  assert.deepEqual(gilmore.people, [{ id: alex.json.id, source: "jellyfin" }]);
});

test("an ignored Seerr user stops counting as needing a link", async () => {
  await api("PUT", "/api/settings", { ignoredSeerrUsers: [3] });
  assert.equal((await api("GET", "/api/overview")).json.totals.unmappedRequests, 0);
  const jamieReq = (await api("GET", "/api/requests")).json.find((r: { seerrUserId: number }) => r.seerrUserId === 3);
  assert.equal(jamieReq.state, "ignored");
  assert.deepEqual(tagsOf("Inside Out 2"), []);
  assert.deepEqual((await api("GET", "/api/settings")).json.ignoredSeerrUsers, [3]);
  // Un-ignoring brings the warning back.
  await api("PUT", "/api/settings", { ignoredSeerrUsers: [] });
  assert.equal((await api("GET", "/api/overview")).json.totals.unmappedRequests, 1);
});

test("a request that arrives later is tagged once it's in Jellyfin", async () => {
  const before = (await api("GET", "/api/requests")).json.find((r: { title: string }) => r.title === "The Substance");
  assert.equal(before.state, "waiting");
  mock.addMovie("The Substance", 933260, 2024);
  await engine.sync("test");
  assert.deepEqual(tagsOf("The Substance"), ["Alex"]);
  const after = (await api("GET", "/api/requests")).json.find((r: { title: string }) => r.title === "The Substance");
  assert.equal(after.state, "tagged");
});

test("removing a tag in the app sticks; drift from outside is repaired", async () => {
  const people = (await api("GET", "/api/people")).json as { id: number; name: string }[];
  const owen = people.find((p) => p.name === "Owen")!;
  const res = await api("POST", "/api/items/tags", { itemIds: [idOf("Dune: Part Two")], remove: [owen.id] });
  assert.equal(res.json.ok, 1);
  assert.deepEqual(tagsOf("Dune: Part Two"), []);
  // A metadata refresh wipes a tag in Jellyfin...
  mock.items.get(idOf("Arrival"))!.Tags = [];
  await engine.sync("test");
  // ...the request isn't re-applied, but the lost tag is.
  assert.deepEqual(tagsOf("Dune: Part Two"), []);
  assert.deepEqual(tagsOf("Arrival"), ["Owen"]);
});

test("linking a Seerr user later applies their past requests", async () => {
  const jamie = ((await api("GET", "/api/people")).json as { id: number; name: string }[]).find((p) => p.name === "Jamie")!;
  await api("PATCH", `/api/people/${jamie.id}`, { seerrUserId: 3 });
  await engine.sync("test");
  assert.deepEqual(tagsOf("Inside Out 2"), ["Jamie"]);
});

test("bulk tagging and the untagged filter", async () => {
  const untagged = (await api("GET", "/api/items?filter=untagged&limit=500")).json;
  assert.ok(untagged.total > 0);
  const alex = ((await api("GET", "/api/people")).json as { id: number; name: string }[]).find((p) => p.name === "Alex")!;
  const ids = untagged.items
    .filter((i: { suggested: number[] }) => !i.suggested.length)
    .slice(0, 2)
    .map((i: { id: string }) => i.id);
  assert.ok(ids.length > 0);
  await api("POST", "/api/items/tags", { itemIds: ids, add: [alex.id] });
  for (const id of ids) assert.ok(mock.items.get(id)!.Tags.includes("Alex"));
  const after = (await api("GET", "/api/items?filter=untagged&limit=500")).json;
  assert.equal(after.total, untagged.total - ids.length);
});

test("watch history becomes suggestions, which can be accepted", async () => {
  const list = (await api("GET", "/api/suggestions")).json as { name: string; itemId: string; personId: number }[];
  const names = list.map((s) => s.name).sort();
  assert.ok(names.includes("Little Women"), names.join());
  assert.ok(names.includes("The Office"), names.join());
  const pick = list.find((s) => s.name === "Little Women")!;
  await api("POST", "/api/suggestions/accept", { pairs: [{ itemId: pick.itemId, personId: pick.personId }] });
  assert.ok(tagsOf("Little Women").includes("Alex"));
  const again = (await api("GET", "/api/suggestions")).json as { name: string }[];
  assert.ok(!again.some((s) => s.name === "Little Women" && pick.personId));
});

test("the unrequested rule tags everything left untagged", async () => {
  const people = (await api("GET", "/api/people")).json as { id: number }[];
  await api("PUT", "/api/settings", { unrequestedAction: "tag", unrequestedPeople: people.map((p) => p.id), unrequestedGraceHours: 0 });
  await engine.sync("test");
  // Everything, except Dune if it's still the one emptied by hand earlier.
  const left = (await api("GET", "/api/items?filter=untagged")).json.items.map((i: { name: string }) => i.name);
  assert.ok(left.every((n: string) => n === "Dune: Part Two"), left.join());
  assert.deepEqual(tagsOf("The Office").sort(), ["Alex", "Jamie", "Owen"]);
  // But one deliberately emptied isn't re-tagged by the rule.
  await api("POST", "/api/items/tags", { itemIds: [idOf("The Office")], remove: people.map((p) => p.id) });
  await engine.sync("test");
  assert.deepEqual(tagsOf("The Office"), []);
  await api("PUT", "/api/settings", { unrequestedAction: "none" });
});

test("tags can be copied down to seasons and episodes", async () => {
  await api("PUT", "/api/settings", { tagChildren: true });
  await engine.sync("test");
  const severance = idOf("Severance");
  const children = [...mock.items.values()].filter((i) => i.SeriesId === severance);
  assert.equal(children.length, 4);
  for (const c of children) assert.deepEqual([...c.Tags].sort(), ["Alex", "Owen"]);
  // Removing a person from the series removes them from its episodes too.
  const alex = ((await api("GET", "/api/people")).json as { id: number; name: string }[]).find((p) => p.name === "Alex")!;
  await api("POST", "/api/items/tags", { itemIds: [severance], remove: [alex.id] });
  for (const c of [...mock.items.values()].filter((i) => i.SeriesId === severance)) assert.deepEqual(c.Tags, ["Owen"]);
  await api("PUT", "/api/settings", { tagChildren: false });
});

test("renaming a person's tag renames it in Jellyfin", async () => {
  const jamie = ((await api("GET", "/api/people")).json as { id: number; name: string }[]).find((p) => p.name === "Jamie")!;
  await api("PATCH", `/api/people/${jamie.id}`, { tag: "Kids" });
  assert.deepEqual(tagsOf("Inside Out 2"), ["Kids"]);
  assert.deepEqual(tagsOf("Bluey"), ["Kids"]);
});

test("access rules set the Jellyfin user's allowed tags", async () => {
  const access = (await api("GET", "/api/access")).json;
  const alexUser = access.users.find((u: { name: string }) => u.name === "alex");
  assert.equal(alexUser.visible, access.total);
  await api("POST", "/api/access/u-alex", { allowedTags: ["Alex"] });
  assert.deepEqual(mock.users[1].Policy.AllowedTags, ["Alex"]);
  // The rest of the policy is untouched.
  assert.equal(mock.users[1].Policy.EnableAllFolders, true);
  const after = (await api("GET", "/api/access")).json.users.find((u: { name: string }) => u.name === "alex");
  assert.ok(after.visible < access.total && after.visible > 0);
});

test("the webhook needs its secret", async () => {
  const settings = (await api("GET", "/api/settings")).json;
  const saved = cookie;
  cookie = "";
  assert.equal((await api("POST", "/api/webhook/wrong", { event: "x" })).status, 401);
  assert.equal((await api("POST", settings.webhookPath, { notification_type: "MEDIA_AVAILABLE" })).status, 200);
  // Seerr's test notification may not be JSON.
  const res = await app.inject({ method: "POST", url: settings.webhookPath, headers: { "content-type": "text/plain" }, payload: "hi" });
  assert.equal(res.statusCode, 200);
  cookie = saved;
});

test("the Homepage widget needs a key, and revoking one locks it out", async () => {
  const created = (await api("POST", "/api/widget-keys", { label: "Homepage" })).json;
  assert.match(created.key, /^tgr_/);
  const saved = cookie;
  cookie = "";
  // Not with a session alone, nor a wrong key.
  assert.equal((await app.inject({ method: "GET", url: "/api/widget" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/widget", headers: { "x-api-key": "tgr_nope" } })).statusCode, 401);
  const res = await app.inject({ method: "GET", url: "/api/widget", headers: { "x-api-key": created.key } });
  assert.equal(res.statusCode, 200);
  const stats = JSON.parse(res.body);
  for (const field of ["untagged", "shared", "waiting", "suggestions", "total", "tagged_pct"]) {
    assert.equal(typeof stats[field], "number", field);
  }
  assert.equal(typeof stats.people.Owen, "number");
  assert.ok(stats.last_sync);
  cookie = saved;
  // The key list never includes the key itself, but shows it was used.
  const keys = (await api("GET", "/api/widget-keys")).json;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key_hash, undefined);
  assert.ok(keys[0].last_used_at);
  await api("DELETE", `/api/widget-keys/${created.id}`);
  assert.equal((await app.inject({ method: "GET", url: "/api/widget", headers: { "x-api-key": created.key } })).statusCode, 401);
});

test("tags items whose cast lists someone twice, leaving the cast alone", async () => {
  const alex = ((await api("GET", "/api/people")).json as { id: number; name: string }[]).find((p) => p.name === "Alex")!;
  const batman = idOf("The Batman");
  const before = mock.items.get(batman)!.People;
  const res = await api("POST", "/api/items/tags", { itemIds: [batman], add: [alex.id] });
  assert.equal(res.json.ok, 1, JSON.stringify(res.json.failed));
  assert.ok(tagsOf("The Batman").includes("Alex"));
  assert.deepEqual(mock.items.get(batman)!.People, before);
});

test("seasons show titles only in season, and keep a collection that hides with them", async () => {
  const people = (await api("GET", "/api/people")).json as { id: number; name: string }[];
  const alex = people.find((p) => p.name === "Alex")!;
  const local = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const day = 86_400_000;
  const inSeason = { start: local(new Date(Date.now() - day)), end: local(new Date(Date.now() + day)), yearly: false };
  const outOfSeason = { start: local(new Date(Date.now() + 20 * day)), end: local(new Date(Date.now() + 30 * day)), yearly: false };
  const collection = () => [...mock.items.values()].find((i) => i.Type === "BoxSet");
  const alexSeesCollection = async () => {
    const res = await fetch(`${mock.jellyfinUrl}/Items?userId=u-alex&IncludeItemTypes=BoxSet`, {
      headers: { Authorization: `MediaBrowser Token="${JELLYFIN_KEY}"` },
    });
    return ((await res.json()) as { Items: unknown[] }).Items.length > 0;
  };
  const before = { coco: [...tagsOf("Coco")].sort(), paddington: [...tagsOf("Paddington 2")].sort() };

  assert.equal((await api("POST", "/api/seasons", { name: "Halloween", start: "2026-10-01T00:00", end: "2026-10-01T00:00" })).status, 400);
  const created = await api("POST", "/api/seasons", {
    name: "Halloween",
    ...inSeason,
    people: [alex.id],
    collection: true,
    itemIds: [idOf("Coco"), idOf("Paddington 2")],
  });
  assert.equal(created.status, 200);
  const id = created.json.id;
  await engine.sync("test");
  assert.equal(engine.status.ok, true, engine.status.error ?? "");

  // In season: only the season's people, whoever else they belong to.
  assert.deepEqual(tagsOf("Coco"), ["Alex"]);
  assert.deepEqual(tagsOf("Paddington 2"), ["Alex"]);
  assert.equal(collection()?.Name, "Halloween");
  assert.deepEqual(collection()?.Children?.sort(), [idOf("Coco"), idOf("Paddington 2")].sort());
  assert.deepEqual(collection()?.Tags, ["Alex"]);
  assert.equal(await alexSeesCollection(), true);
  const season = (await api("GET", `/api/seasons/${id}`)).json;
  assert.equal(season.status.active, true);
  assert.equal(season.items.length, 2);

  // The season decides: tagging by hand is refused, and the library says why.
  const manual = await api("POST", "/api/items/tags", { itemIds: [idOf("Coco")], add: [people[0].id] });
  assert.equal(manual.json.ok, 0);
  assert.match(manual.json.failed[0].error, /Halloween season/);
  const coco = (await api("GET", "/api/items?q=coco")).json.items[0];
  assert.deepEqual(coco.seasons.map((s: { name: string; active: boolean }) => [s.name, s.active]), [["Halloween", true]]);

  // Out of season: hidden from everyone, collection included, and not counted as untagged.
  await api("PATCH", `/api/seasons/${id}`, outOfSeason);
  await engine.sync("test");
  assert.deepEqual(tagsOf("Coco"), []);
  assert.deepEqual(tagsOf("Paddington 2"), []);
  assert.deepEqual(collection()?.Tags, []);
  assert.equal(await alexSeesCollection(), false);
  const untagged = (await api("GET", "/api/items?filter=untagged&limit=500")).json.items.map((i: { name: string }) => i.name);
  assert.ok(!untagged.includes("Coco"));
  assert.equal((await api("GET", "/api/items?filter=seasonal")).json.total, 2);
  assert.ok((await api("GET", "/api/activity")).json.some((a: { message: string }) => /Halloween is out of season/.test(a.message)));
  // Nothing is due until it starts again.
  assert.equal(engine.checkSeasons(), false);

  // The minute check notices a season starting without waiting for the next sync.
  db().prepare("UPDATE seasons SET start_at = ?, end_at = ? WHERE id = ?").run(inSeason.start, inSeason.end, id);
  assert.equal(engine.checkSeasons(), true);
  await engine.sync("test");
  assert.deepEqual(tagsOf("Coco"), ["Alex"]);

  // Taken out of the season, a title goes back to who it belongs to.
  await api("POST", `/api/seasons/${id}/items`, { remove: [idOf("Coco")] });
  assert.deepEqual([...tagsOf("Coco")].sort(), before.coco);
  await engine.sync("test");
  assert.deepEqual(collection()?.Children, [idOf("Paddington 2")]);

  // Deleting the season deletes its collection and restores the rest.
  await api("DELETE", `/api/seasons/${id}`);
  assert.equal(collection(), undefined);
  assert.deepEqual([...tagsOf("Paddington 2")].sort(), before.paddington);
});
