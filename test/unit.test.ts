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
