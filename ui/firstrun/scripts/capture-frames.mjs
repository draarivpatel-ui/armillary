#!/usr/bin/env node
/**
 * Deterministic first-run capture: seeks the scene to exact times and screenshots each frame.
 * The page replays the recorded (synthetic) event log; nothing touches real agent data.
 *
 *   node scripts/capture-frames.mjs --times 1000,4000,9000 --out /tmp/armillary-firstrun/frames
 *   node scripts/capture-frames.mjs --video --fps 60 --out /tmp/armillary-firstrun/video.mp4 --w 1920 --h 1080 --dpr 1
 *
 * Options: --w --h --dpr (default 1440 900 2), --renderer auto|webgl2|canvas2d, --reduced,
 * --consent <ms> (default 9600), --skip <ms>, --decline <ms>, --prefix <name>, --from/--to (video range),
 * --gpu (headed Chrome with the real GPU; default headless), --sheet <ms list> (contact sheet of frames).
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function args() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, "");
    const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1";
    o[k] = v;
  }
  return o;
}

const opt = args();
const W = Number(opt.w ?? 1440);
const H = Number(opt.h ?? 900);
const DPR = Number(opt.dpr ?? 2);
const renderer = opt.renderer ?? "auto";
const reduced = opt.reduced === "1";
const consentAt = Number(opt.consent ?? 9600);
const out = opt.out ?? "/tmp/armillary-firstrun/frames";
const prefix = opt.prefix ?? "fr";
const FFMPEG = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const addr = server.httpServer.address();
const base = `http://127.0.0.1:${addr.port}`;

const headed = opt.gpu === "1";
const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  headless: !headed,
  args: headed ? ["--enable-gpu-rasterization", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, reducedMotion: reduced ? "reduce" : "no-preference" });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.error("[page]", m.text());
});
page.on("pageerror", (e) => console.error("[page error]", e.message));
await page.goto(`${base}/capture.html?renderer=${renderer}${reduced ? "&reduced=1" : ""}`);
await page.waitForFunction(() => window.__armillaryFirstRun && window.__armillaryFirstRun.ready, null, { timeout: 30000 });
const scriptOpts = { consentAt };
if (opt.skip) scriptOpts.skipAt = Number(opt.skip);
if (opt.decline) scriptOpts.declineAt = Number(opt.decline);
await page.evaluate((o) => window.__armillaryFirstRun.script(o), scriptOpts);
const info = await page.evaluate(() => ({ r: window.__armillaryFirstRun.renderer(), s: window.__armillaryFirstRun.state() }));
console.log(`renderer=${info.r} scanEnd=${info.s.scanEndAt} handoff=${info.s.handoffAt} complete=${info.s.completeAt}`);

const seek = (ms) => page.evaluate((t) => window.__armillaryFirstRun.seek(t), ms);

if (opt.video === "1") {
  const fps = Number(opt.fps ?? 60);
  const from = Number(opt.from ?? 0);
  const to = Number(opt.to ?? (info.s.completeAt ?? 30000) + 400);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", String(opt.crf ?? 20), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  ff.stderr.on("data", (d) => process.stderr.write(d));
  const n = Math.ceil(((to - from) / 1000) * fps);
  for (let i = 0; i <= n; i++) {
    const t = from + (i * 1000) / fps;
    await seek(t);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 120 === 0) console.log(`frame ${i}/${n} t=${t.toFixed(0)}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", out);
} else {
  fs.mkdirSync(out, { recursive: true });
  const times = (opt.times ?? "1000,2200,3600,4800,6000,7600,9000").split(",").map(Number);
  for (const t of times) {
    await seek(t);
    const file = path.join(out, `${prefix}-${String(t).padStart(6, "0")}.png`);
    await page.screenshot({ path: file });
    const st = await page.evaluate(() => window.__armillaryFirstRun.state());
    console.log(file, st.phase);
  }
}
await browser.close();
await server.close();
