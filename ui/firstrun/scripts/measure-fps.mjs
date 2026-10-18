#!/usr/bin/env node
/**
 * Frame times of the first run in Chrome with the real GPU (headed: headless Chrome falls back to
 * SwiftShader for WebGL, which says nothing about performance). Plays the scripted run in real time
 * and prints the host's frame-time reports (rAF interval and per-frame work, p50/p95 per 600 frames).
 *
 *   node scripts/measure-fps.mjs [--renderer auto|webgl2|canvas2d] [--w 1440 --h 900 --dpr 2]
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i].replace(/^--/, "");
  opt[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1";
}
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: false, args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const page = await (await browser.newContext({ viewport: { width: Number(opt.w ?? 1440), height: Number(opt.h ?? 900) }, deviceScaleFactor: Number(opt.dpr ?? 2) })).newPage();
const lines = [];
let done = false;
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[armillary-fps]")) {
    lines.push(t);
    console.log(t);
    if (t.includes("phase=complete")) done = true;
  }
});
await page.goto(`${base}/capture.html?autoplay=1&fps=1&renderer=${opt.renderer ?? "auto"}`);
const gl = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const g = c.getContext("webgl2");
  const ext = g && g.getExtension("WEBGL_debug_renderer_info");
  return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g ? "webgl2 (renderer hidden)" : "no webgl2";
});
console.log("gpu:", gl);
const t0 = Date.now();
while (!done && Date.now() - t0 < 60000) await page.waitForTimeout(250);
await browser.close();
await server.close();
