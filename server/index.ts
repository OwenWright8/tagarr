// Entry point. Everything is configured in the web UI; the environment only
// holds deployment details, all optional:
//   PORT          port to listen on inside the container (default 8686)
//   DATA_DIR      where the database lives (default /data, or ./data outside Docker)
//   UPDATE_CHECK  "off" stops the daily-ish check for new releases
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8686);
const dataDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve(here, "../data"));
const version = process.env.AUTOTAGARR_BUILD_VERSION || "dev";
const repo = process.env.AUTOTAGARR_REPO || "OwenWright8/autotagarr";
const updateCheck = !/^(off|false|0|no)$/i.test(process.env.UPDATE_CHECK ?? "on");

const db = openDb(path.join(dataDir, "autotagarr.db"));
const { app, engine, updates } = await buildApp({
  db,
  version,
  repo,
  updateCheck,
  webRoot: path.resolve(here, "../dist/web"),
});

await app.listen({ host: "0.0.0.0", port });
console.log(`[autotagarr] ${version} listening on :${port} (data in ${dataDir})`);
engine.start();
updates.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    engine.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
