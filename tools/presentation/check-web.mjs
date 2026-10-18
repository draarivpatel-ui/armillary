// Walks the web build in presentation mode (?presentation=1, answered by demo/presentation/snapshot.json
// through app/src/presentation/bridge.ts) and photographs every view plus the Folio opened from Search.
// Usage: node tools/presentation/check-web.mjs <out-dir>   (first: cd app && VITE_ARMILLARY_PRESENTATION=1 npm run build)
// Writes PNGs and report.json (console errors, data mode, counts read from the page). Nothing leaves the
// machine: a local static server and headless Chrome.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node tools/presentation/check-web.mjs <out-dir>");
  process.exit(64);
}
if (out === root || out.startsWith(root + path.sep)) {
  console.error(`refusing: out-dir ${out} is inside the repo`);
  process.exit(65);
}
fs.mkdirSync(out, { recursive: true });

const { chromium } = await import(path.join(root, "app/node_modules/playwright/index.mjs")).catch(() => import("playwright"));
const { createScreenshotServer } = await import(path.join(root, "app/scripts/server.js"));
const server = createScreenshotServer(path.join(root, "app/dist"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/?presentation=1`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const report = { base, shots: [], consoleErrors: [], checks: {} };
try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") report.consoleErrors.push(`${theme}: ${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => report.consoleErrors.push(`${theme}: pageerror: ${e.message}`));
    await page.goto(base);
    await page.waitForFunction(() => Boolean(window.__armillaryTour), null, { timeout: 15000 });
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      for (const el of document.querySelectorAll("[data-theme]")) el.setAttribute("data-theme", t);
    }, theme);
    const shot = async (name) => {
      await page.waitForTimeout(700);
      const file = path.join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file });
      report.shots.push(file);
    };
    const key = async (k) => {
      await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => {});
      await page.keyboard.press(k);
    };
    // 1 Orrery, with the live swing if the snapshot has one
    await key("1");
    await shot("1-orrery");
    report.checks[`${theme}.tour`] = await page.evaluate(() => window.__armillaryTour.state());
    if (report.checks[`${theme}.tour`].liveSteps > 1) {
      await page.evaluate(() => window.__armillaryTour.advanceLive(1));
      await shot("1b-orrery-after-live-step");
    }
    // 2 Almanac
    await key("2");
    await page.waitForSelector('[data-testid="almanac-session-item"]', { timeout: 15000 });
    report.checks[`${theme}.almanacRows`] = await page.locator('[data-testid="almanac-session-item"]').count();
    await shot("2-almanac");
    // 7 Search, then open the first hit in the Folio
    await key("7");
    await page.fill('input[type="search"]', "Doppler radar sweep");
    await page.waitForSelector('[data-testid="search-hit-item"]', { timeout: 15000 });
    report.checks[`${theme}.searchHits`] = await page.locator('[data-testid="search-hit-item"]').count();
    report.checks[`${theme}.searchMarks`] = await page.locator('[data-testid="hit-snippet"] mark').count();
    await shot("3-search");
    await page.locator('[data-testid="search-hit-item"]').first().click();
    await page.waitForSelector('[data-folio-state="ready"] .folio-row', { timeout: 15000 });
    report.checks[`${theme}.folioRows`] = await page.locator(".folio-row").count();
    report.checks[`${theme}.folioCurrentSeq`] = await page.locator('.folio-row[data-current="true"]').first().getAttribute("data-seq").catch(() => null);
    await shot("4-folio-from-search");
    // 4 Field Guide, 5 Switchboard, 6 Launchpad
    await key("4");
    await page.waitForSelector('[data-testid^="agent-card-"]', { timeout: 15000 });
    report.checks[`${theme}.fieldGuideCards`] = await page.locator('[data-testid^="agent-card-"]').count();
    await shot("5-field-guide");
    await key("5");
    await shot("6-switchboard");
    await key("6");
    await shot("7-launchpad");
    report.checks[`${theme}.demoDataText`] = await page.evaluate(() => document.body.innerText.includes("Demo data"));
    report.checks[`${theme}.dataMode`] = await page.evaluate(() => (window.__ARMILLARY_PRESENTATION__ ? "presentation" : "other"));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.checks, null, 1));
console.log(`console errors/warnings: ${report.consoleErrors.length}`);
for (const e of report.consoleErrors.slice(0, 20)) console.log("  " + e);
