// UI smoke test and README screenshots, in one pass. Starts the fake Jellyfin
// and Seerr (scripts/mock-servers.ts) and a fresh Autotagarr, walks through the
// setup wizard in Chromium like a new user, then visits every page.
//
//   npm run build && npm run screenshots          # smoke test only
//   SCREENSHOTS=1 npm run screenshots             # also writes docs/screenshots/*.png
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import { JELLYFIN_KEY, SEERR_KEY, startMocks } from "./mock-servers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/screenshots");
const write = process.env.SCREENSHOTS === "1";

const mock = await startMocks();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotagarr-shots-"));
const { app, engine } = await buildApp({
  db: openDb(path.join(dataDir, "db.sqlite")),
  version: "v1.0.0",
  repo: "OwenWright8/autotagarr",
  updateCheck: false,
  webRoot: path.join(root, "dist/web"),
});
await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const errors: string[] = [];
let failed = false;

async function newPage(opts: { dark?: boolean; mobile?: boolean; storage?: string } = {}) {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 920 },
    deviceScaleFactor: 2,
    colorScheme: opts.dark ? "dark" : "light",
    isMobile: opts.mobile,
    hasTouch: opts.mobile,
    storageState: opts.storage,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`console: ${m.text()}`));
  return page;
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400); // fade-in animations
  if (write) await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage });
  console.log(`  ✓ ${name}`);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

try {
  if (write) fs.mkdirSync(outDir, { recursive: true });
  console.log("Setup wizard");
  const page = await newPage();
  await page.goto(base);
  await step("create account", async () => {
    await page.getByLabel("Username").fill("owen");
    await page.getByLabel("Password", { exact: true }).fill("demo-password");
    await page.getByLabel("Confirm password").fill("demo-password");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByText("Connect Jellyfin").waitFor();
  });
  await step("jellyfin", async () => {
    await page.getByLabel("Jellyfin address").fill(mock.jellyfinUrl);
    await page.getByLabel("API key").fill(JELLYFIN_KEY);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByText("Connect Seerr").waitFor();
  });
  await step("seerr", async () => {
    await page.getByLabel("Seerr address").fill(mock.seerrUrl);
    await page.getByLabel("API key").fill(SEERR_KEY);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByText("Who shares the library?").waitFor();
  });
  await step("people", async () => {
    // Owen and Alex from Seerr; Jamie is added by hand later, so their request shows as unlinked.
    for (const name of ["Owen", "Alex"]) {
      const card = page.locator("div.border-dashed", { hasText: name }).first();
      await card.getByRole("button", { name: "Add" }).click();
      await page.locator("li", { hasText: name }).first().waitFor();
    }
    await shot(page, "setup");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Finish and sync" }).click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await engine.sync("screenshots");
  });
  await step("add Jamie by hand", async () => {
    await page.goto(`${base}/settings#people`);
    await page.getByRole("button", { name: "Add a person or tag" }).click();
    await page.getByLabel("Name").fill("Jamie");
    await page.getByLabel("Jellyfin user").selectOption({ label: "jamie" });
    await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
    await page.locator("li", { hasText: "Jamie" }).first().waitFor();
    await engine.sync("screenshots");
  });
  const storage = path.join(dataDir, "state.json");
  await page.context().storageState({ path: storage });
  await page.context().close();

  for (const dark of [false, true]) {
    const suffix = dark ? "-dark" : "-light";
    console.log(dark ? "Dark" : "Light");
    const p = await newPage({ dark, storage });
    await step("overview", async () => {
      await p.goto(base);
      await p.getByText("Recent activity").waitFor();
      await shot(p, `overview${suffix}`);
    });
    await step("library", async () => {
      await p.goto(`${base}/library`);
      await p.getByText("Severance").first().waitFor();
      await shot(p, `library${suffix}`);
    });
    if (!dark) {
      await step("toggle a tag from the grid", async () => {
        await p.goto(`${base}/library?filter=untagged`);
        const card = p.locator("div.group", { hasText: "The Grand Budapest Hotel" });
        await card.getByRole("button", { name: /Add Owen/ }).click();
        await card.getByRole("button", { name: /Remove Owen/ }).waitFor({ timeout: 5000 }).catch(() => {});
        if (!mock.items.get([...mock.items.values()].find((i) => i.Name === "The Grand Budapest Hotel")!.Id)!.Tags.includes("Owen")) {
          throw new Error("tag didn't reach Jellyfin");
        }
      });
      await step("item details", async () => {
        await p.goto(`${base}/library`);
        await p.locator("div.group", { hasText: "Severance" }).locator("button").first().click();
        await p.getByText("Who it's for").waitFor();
        await shot(p, "item");
        await p.keyboard.press("Escape");
      });
      await step("bulk select", async () => {
        await p.goto(`${base}/library?filter=untagged`);
        await p.getByRole("button", { name: "Select", exact: true }).click();
        await p.getByRole("button", { name: /^Select all/ }).click();
        await p.getByText(/\d+ selected/).waitFor();
        await shot(p, "bulk");
      });
      await step("requests", async () => {
        await p.goto(`${base}/requests`);
        await p.getByText("The Substance").waitFor();
        await shot(p, "requests");
      });
      await step("suggestions", async () => {
        await p.goto(`${base}/suggestions`);
        await p.getByText("Alex watched").waitFor();
        await shot(p, "suggestions");
      });
      await step("access", async () => {
        await p.goto(`${base}/access`);
        await p.getByText("Linked to Alex").waitFor();
        await p.locator("div.rounded-xl", { hasText: "Linked to Alex" }).getByRole("button", { name: "Change" }).click();
        await p.getByRole("button", { name: "Save to Jellyfin" }).click();
        await p.getByText(/Sees items tagged/).first().waitFor();
        if (mock.users[1].Policy.AllowedTags[0] !== "Alex") throw new Error("policy not saved");
        await shot(p, "access");
      });
      await step("activity", async () => {
        await p.goto(`${base}/activity`);
        await shot(p, "activity");
      });
      await step("settings", async () => {
        await p.goto(`${base}/settings`);
        await p.getByText("Instant tagging").waitFor();
        await shot(p, "settings", true);
      });
    }
    await p.context().close();
  }

  console.log("Mobile");
  const m = await newPage({ mobile: true, storage });
  await step("mobile library", async () => {
    await m.goto(`${base}/library`);
    await m.getByText("Severance").first().waitFor();
    await shot(m, "mobile-library");
  });
  await step("mobile overview", async () => {
    await m.goto(base);
    await m.getByText("Recent activity").waitFor();
    await shot(m, "mobile-overview");
  });
  await m.context().close();
} finally {
  await browser.close();
  engine.stop();
  await app.close();
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (errors.length) {
  console.error("\nBrowser errors:\n" + errors.map((e) => "  " + e).join("\n"));
  failed = true;
}
process.exit(failed ? 1 : 0);
