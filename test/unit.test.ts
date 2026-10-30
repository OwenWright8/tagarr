import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTagEdit, hasTag } from "../server/jellyfin.ts";
import { isNewer } from "../server/update-check.ts";
import { hashPassword, verifyPassword, LoginLimiter } from "../server/auth.ts";

test("tag edits keep other tags and their order, case-insensitively", () => {
  assert.deepEqual(applyTagEdit(["IMAX", "owen"], ["Owen", "Alex"], []), ["IMAX", "owen", "Alex"]);
  assert.deepEqual(applyTagEdit(["IMAX", "Owen", "Alex"], [], ["owen"]), ["IMAX", "Alex"]);
  assert.deepEqual(applyTagEdit([], [], ["x"]), []);
  assert.ok(hasTag(["Owen"], "OWEN"));
});

test("version comparison", () => {
  assert.equal(isNewer("v1.2.0", "v1.1.9"), true);
  assert.equal(isNewer("v1.2.0", "v1.2.0"), false);
  assert.equal(isNewer("v1.2.0", "v1.10.0"), false);
  assert.equal(isNewer("v1.2.0", "v1.2.0-rc.1"), true);
  assert.equal(isNewer("v9.9.9", "dev"), false);
  assert.equal(isNewer(null, "v1.0.0"), false);
});

test("passwords", () => {
  const h = hashPassword("correct horse");
  assert.ok(verifyPassword("correct horse", h));
  assert.ok(!verifyPassword("wrong horse", h));
  assert.ok(!verifyPassword("x", "garbage"));
});

test("login limiter", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 10; i++) l.fail("1.2.3.4");
  assert.ok(l.blocked("1.2.3.4"));
  assert.ok(!l.blocked("5.6.7.8"));
  l.reset("1.2.3.4");
  assert.ok(!l.blocked("1.2.3.4"));
});

test("a repeated error is logged once", async () => {
  const { openDb, logActivity } = await import("../server/db.ts");
  const db = openDb(":memory:");
  for (let i = 0; i < 3; i++) logActivity(db, "error", "Couldn't tag X: 500");
  logActivity(db, "error", "Couldn't tag Y: 500");
  logActivity(db, "tagged", "X → Owen");
  logActivity(db, "tagged", "X → Owen");
  const rows = db.prepare("SELECT kind, message FROM activity").all() as { kind: string }[];
  assert.equal(rows.filter((r) => r.kind === "error").length, 2);
  assert.equal(rows.filter((r) => r.kind === "tagged").length, 2);
});

test("tag edits send back only the fields Jellyfin's editor reads", async () => {
  const { editableFields } = await import("../server/jellyfin.ts");
  const out = editableFields({
    Id: "x", Type: "Movie", Name: "Good Boys", Overview: "o", ProductionYear: 2019, Tags: ["A"],
    ProviderIds: { Tmdb: "1" }, LockedFields: [], People: [{ Name: "Seth" }],
    Trickplay: { x: {} }, MediaSources: [], UserData: {}, ImageTags: {},
  });
  assert.deepEqual(Object.keys(out).sort(), ["LockedFields", "Name", "Overview", "ProductionYear", "ProviderIds", "Tags"]);
});

test("season windows, yearly and one-off", async () => {
  const { seasonStatus, checkWindow } = await import("../server/seasons.ts");
  const halloween = { start_at: "2020-10-01T00:00", end_at: "2020-11-01T00:00", yearly: 1 };
  assert.equal(seasonStatus(halloween, new Date(2026, 9, 15)).active, true);
  assert.equal(seasonStatus(halloween, new Date(2026, 10, 1, 0, 0)).active, false); // ends at midnight
  const off = seasonStatus(halloween, new Date(2026, 10, 2));
  assert.equal(off.active, false);
  assert.deepEqual(off.start, new Date(2027, 9, 1)); // next year's start
  // Wrapping past New Year.
  const holidays = { start_at: "2020-12-20T18:00", end_at: "2020-01-06T00:00", yearly: 1 };
  assert.equal(seasonStatus(holidays, new Date(2027, 0, 2)).active, true);
  assert.deepEqual(seasonStatus(holidays, new Date(2027, 0, 2)).end, new Date(2027, 0, 6));
  assert.equal(seasonStatus(holidays, new Date(2026, 11, 20, 17, 59)).active, false);
  assert.equal(seasonStatus(holidays, new Date(2026, 11, 20, 18, 0)).active, true);
  // One-off: over once it's passed.
  const once = { start_at: "2026-07-01T09:00", end_at: "2026-07-04T23:00", yearly: 0 };
  assert.equal(seasonStatus(once, new Date(2026, 6, 2)).active, true);
  assert.equal(seasonStatus(once, new Date(2026, 6, 5)).over, true);
  assert.equal(checkWindow("2026-07-04T23:00", "2026-07-01T09:00", false), "The season has to end after it starts");
  assert.equal(checkWindow("2026-12-20T18:00", "2026-01-06T00:00", true), null);
  assert.equal(checkWindow("2026-02-30T00:00", "2026-03-01T00:00", true), "Pick when the season starts");
});

test("the update check keeps the release's notes, cleaned up", async () => {
  const http = await import("node:http");
  const { UpdateChecker } = await import("../server/update-check.ts");
  let release: unknown = {
    tag_name: "v9.1.0",
    html_url: "https://github.com/x/y/releases/tag/v9.1.0",
    published_at: "2026-10-30T00:00:00Z",
    body: "<!-- generated -->\r\n## What's changed\r\n\r\n\r\n\r\n- Add seasonal titles\r\n- Fix a thing\r\n",
  };
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/repos/x/y/releases/latest" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(release));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const checker = new UpdateChecker(true, "x/y", base);
    assert.equal(await checker.check(), true);
    assert.equal(checker.info.latest, "v9.1.0");
    assert.equal(checker.info.notes, "## What's changed\n\n- Add seasonal titles\n- Fix a thing");
    assert.equal(checker.info.publishedAt, "2026-10-30T00:00:00Z");
    // Anything that doesn't look like a GitHub release is ignored.
    release = { tag_name: "v9.2.0", html_url: "https://evil.example/" };
    assert.equal(await checker.check(), false);
    assert.equal(checker.info.latest, "v9.1.0");
    // Off means off.
    assert.equal(await new UpdateChecker(false, "x/y", base).checkNow(), false);
  } finally {
    server.close();
  }
});
