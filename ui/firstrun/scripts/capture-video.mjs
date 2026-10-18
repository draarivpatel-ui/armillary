#!/usr/bin/env node
/**
 * A frame-exact video of the whole first run inside the app's web build (?firstrun=1), hand-over
 * into the real shell included. A virtual clock is installed before the page loads:
 * requestAnimationFrame, performance.now, Date.now and timers advance only when this script steps a
 * frame, so the first run and the live Orrery underneath share one deterministic clock (no
 * time-lapse while frames are photographed). Without a core the gate replays the recorded mock log.
 *
 *   node scripts/capture-video.mjs --out /tmp/armillary-firstrun/firstrun.mp4 [--w 1920 --h 1080 --dpr 1 --fps 60]
 *   node scripts/capture-video.mjs --frames 1000,9000,15000 --out /tmp/armillary-firstrun/vframes   (stills)
 *   add --presentation to run the app on INT's presentation snapshot (the landing then meets the
 *   dataset's own projects); add --names a,b,c to name the stills.
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
const W = Number(opt.w ?? 1920);
const H = Number(opt.h ?? 1080);
const DPR = Number(opt.dpr ?? 1);
const FPS = Number(opt.fps ?? 60);
const consentAt = Number(opt.consent ?? 9600);
const out = opt.out ?? "/tmp/armillary-firstrun/firstrun.mp4";
const FFMPEG = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Installed before any page script: one virtual clock for rAF, performance.now, Date.now and timers. */
const SHIM = `(() => {
  let vt = 0;
  const epoch = 1760000000000;
  let rafId = 0;
  let rafs = new Map();
  let timerId = 0;
  const timers = new Map();
  performance.now = () => vt;
  const RealDate = Date;
  class VDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(epoch + vt); else super(...args); }
    static now() { return epoch + vt; }
  }
  window.Date = VDate;
  window.requestAnimationFrame = (cb) => { rafId += 1; rafs.set(rafId, cb); return rafId; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.setTimeout = (cb, ms = 0, ...args) => { timerId += 1; timers.set(timerId, { at: vt + Math.max(0, ms), cb, args, every: 0 }); return timerId; };
  window.setInterval = (cb, ms = 0, ...args) => { timerId += 1; timers.set(timerId, { at: vt + Math.max(1, ms), cb, args, every: Math.max(1, ms) }); return timerId; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.__vt = {
    now: () => vt,
    advance: (ms) => {
      const end = vt + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (next === null || t.at < timers.get(next).at)) next = id;
        if (next === null) break;
        const t = timers.get(next);
        vt = Math.max(vt, t.at);
        if (t.every) t.at += t.every; else timers.delete(next);
        try { t.cb(...t.args); } catch (e) { console.error(e); }
      }
      vt = end;
      const run = rafs;
      rafs = new Map();
      for (const cb of run.values()) { try { cb(vt); } catch (e) { console.error(e); } }
    },
  };
})();`;

const server = await createServer({ root: appRoot, configFile: path.join(appRoot, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
await ctx.addInitScript(SHIM);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[page error]", e.message));
// --presentation: the app answers from INT's presentation snapshot (the same synthetic dataset the
// recorded log was made from), and the first run replays that recorded log.
const query = opt.presentation ? "?presentation=1&firstrun=1&firstrunSource=recorded" : "?firstrun=1";
await page.goto(`${base}/${query}`);
const step = (ms) => page.evaluate((m) => window.__vt.advance(m), ms);
// Fonts and modules load in real time; step the virtual clock gently until the first run is ready.
for (let i = 0; i < 600; i++) {
  const ready = await page.evaluate(() => !!(window.__armillaryFirstRun && window.__armillaryFirstRun.ready));
  if (ready) break;
  await step(16);
  await page.waitForTimeout(20);
}
await page.evaluate((c) => window.__armillaryFirstRun.script({ consentAt: c }), consentAt);
const st = await page.evaluate(() => window.__armillaryFirstRun.state());
console.log(`scanEnd=${st.scanEndAt} handoff=${st.handoffAt} complete=${st.completeAt}`);
// seek() resolves after two animation frames, which only fire when this script steps the clock:
// start it without awaiting, then step.
await page.evaluate(() => {
  void window.__armillaryFirstRun.seek(0);
  window.__armillaryFirstRun.play();
});
await step(1);
const dt = 1000 / FPS;
const endAt = Number(opt.to ?? (st.completeAt ?? 28000) + 900);

if (opt.frames) {
  const want = opt.frames.split(",").map(Number).sort((x, y) => x - y);
  fs.mkdirSync(out, { recursive: true });
  let t = 0;
  for (const target of want) {
    while (t + dt <= target) {
      await step(dt);
      t += dt;
    }
    const names = opt.names ? opt.names.split(",") : null;
    const file = path.join(out, names ? `${names[want.indexOf(target)]}.png` : `video-${String(Math.round(t)).padStart(6, "0")}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", String(opt.crf ?? 22), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  ff.stderr.on("data", (d) => process.stderr.write(d));
  const n = Math.ceil(endAt / dt);
  for (let i = 0; i <= n; i++) {
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    await step(dt);
    if (i % 300 === 0) console.log(`frame ${i}/${n}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", out, fs.statSync(out).size, "bytes");
}
await browser.close();
await server.close();
