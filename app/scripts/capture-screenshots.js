import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");
const screenshotsDir = path.resolve(__dirname, "../screenshots");
const designScreenshotsDir = path.resolve(__dirname, "../../design/screenshots");

fs.mkdirSync(screenshotsDir, { recursive: true });
fs.mkdirSync(designScreenshotsDir, { recursive: true });

import { createScreenshotServer } from "./server.js";

// Hardened static server for dist contained to canonical root
const server = createScreenshotServer(distDir);

// A browser binary can be given with CHROME_PATH; otherwise Playwright uses its own installed browser.
const executablePath = process.env.CHROME_PATH || undefined;

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  console.log(`Static server running on http://127.0.0.1:${port}`);

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2, // HiDPI crisp rendering
  });

  try {
    await page.goto(`http://localhost:${port}`);
    await page.waitForLoadState("networkidle");

    // 1. Capture Orrery View (Dark)
    console.log("Capturing Orrery View (Dark)...");
    const orreryDarkPath = path.join(screenshotsDir, "orrery-dark.png");
    await page.screenshot({ path: orreryDarkPath });

    // 2. Switch to Design Gallery View
    console.log("Navigating to Design Gallery...");
    await page.click('button:has-text("Design Gallery")');
    await page.waitForTimeout(300);

    // Capture Gallery in Dark Theme
    console.log("Capturing Design Gallery (Dark)...");
    const galleryDarkPath = path.join(screenshotsDir, "gallery-dark.png");
    await page.screenshot({ path: galleryDarkPath, fullPage: true });

    // 3. Switch to Day Almanac Light Theme
    console.log("Switching to Day Almanac Light Theme...");
    await page.click('button:has-text("Day Almanac")');
    await page.waitForTimeout(300);

    // Capture Gallery in Day Almanac Light Theme
    console.log("Capturing Design Gallery (Day Almanac Light)...");
    const galleryLightPath = path.join(screenshotsDir, "gallery-day-almanac.png");
    await page.screenshot({ path: galleryLightPath, fullPage: true });

    // 4. Switch back to Orrery in Light Theme
    console.log("Capturing Orrery View (Day Almanac Light)...");
    await page.click('button:has-text("Orrery")');
    await page.waitForTimeout(300);
    const orreryLightPath = path.join(screenshotsDir, "orrery-day-almanac.png");
    await page.screenshot({ path: orreryLightPath });

    // Copy gallery screenshots to design/screenshots for design package documentation
    fs.copyFileSync(galleryDarkPath, path.join(designScreenshotsDir, "gallery-dark.png"));
    fs.copyFileSync(galleryLightPath, path.join(designScreenshotsDir, "gallery-day-almanac.png"));

    console.log("Screenshots captured successfully:");
    console.log(`- ${galleryDarkPath}`);
    console.log(`- ${galleryLightPath}`);
    console.log(`- ${orreryDarkPath}`);
    console.log(`- ${orreryLightPath}`);
  } catch (err) {
    console.error("Error capturing screenshots:", err);
  } finally {
    await browser.close();
    server.close();
  }
});
