#!/usr/bin/env node
/**
 * The first run inside the app's web build (the gate with ?firstrun=1), so the hand-over lands on the
 * real shell and the real Orrery. Without a core the gate replays the recorded mock log and the app
 * shows its web-build data; add --presentation to use INT's presentation snapshot instead.
 *
 *   node scripts/capture-app.mjs --times 24000,25000,26500,27500,28200 --out /tmp/armillary-firstrun/app
 *   node scripts/capture-app.mjs --video --from 22000 --to 29000 --fps 30 --out /tmp/armillary-firstrun/app.mp4
 *
 * The app is mounted by the gate when the constellation scene begins; the script seeks there first
 * and waits (real time) for the app to lay out before stepping through the hand-over.
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../../../app");
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i].replace(/^--/, "");
  opt[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1";
}
const W = Number(opt.w ?? 1440);
const H = Number(opt.h ?? 900);
const DPR = Number(opt.dpr ?? 2);
const consentAt = Number(opt.consent ?? 9600);
const out = opt.out ?? "/tmp/armillary-firstrun/app";
const theme = opt.theme ?? "dark";
const FFMPEG = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const server = await createServer({ root: appRoot, configFile: path.join(appRoot, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  headless: opt.gpu !== "1",
  args: opt.gpu === "1" ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })).newPage();
page.on("pageerror", (e) => console.error("[page error]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("[page]", m.text());
});
await page.goto(`${base}/?firstrun=1${opt.presentation ? "&presentation=1" : ""}`);
await page.waitForFunction(() => window.__armillaryFirstRun && window.__armillaryFirstRun.ready, null, { timeout: 60000 });
if (theme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await page.evaluate((c) => window.__armillaryFirstRun.script({ consentAt: c }), consentAt);
const st = await page.evaluate(() => window.__armillaryFirstRun.state());
console.log(`scanEnd=${st.scanEndAt} handoff=${st.handoffAt} complete=${st.completeAt}`);
// After completion the gate unmounts the first run (and its API): later frames are the app itself.
const seek = (ms) => page.evaluate((t) => (window.__armillaryFirstRun ? window.__armillaryFirstRun.seek(t) : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))), ms);
// Let the gate mount the app underneath at the start of the constellation scene, then lay out.
await seek((st.scanEndAt ?? 15000) + 50);
await page.waitForTimeout(1500);
// The app sets its own theme when it mounts; switch it now (html and the shell's own copy).
if (theme === "light")
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    document.querySelectorAll("[data-theme]").forEach((el) => el.setAttribute("data-theme", "light"));
  });
await seek((st.handoffAt ?? 24000) + 10);
await page.waitForTimeout(300);

if (opt.video === "1") {
  const fps = Number(opt.fps ?? 30);
  const from = Number(opt.from ?? (st.handoffAt ?? 24000) - 1000);
  const to = Number(opt.to ?? (st.completeAt ?? 28000) + 500);
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", out]);
  for (let t = from; t <= to; t += 1000 / fps) {
    await seek(t);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", out);
} else {
  fs.mkdirSync(out, { recursive: true });
  const times = (opt.times ?? "24000,25000,26000,27000,27600,28200").split(",").map(Number);
  for (const t of times) {
    await seek(t);
    const file = path.join(out, `app-${theme}-${String(t).padStart(6, "0")}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
}
await browser.close();
await server.close();
