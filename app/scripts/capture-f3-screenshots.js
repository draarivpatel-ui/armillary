import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");
const screenshotsDir = path.resolve(__dirname, "../screenshots");

fs.mkdirSync(screenshotsDir, { recursive: true });

import { createScreenshotServer } from "./server.js";

const server = createScreenshotServer(distDir);

const executablePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  console.log(`Static server running on http://127.0.0.1:${port}`);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
    });
  } catch (e) {
    console.error("Failed to launch chromium with default executable:", e.message);
    server.close();
    process.exit(1);
  }

  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });

  try {
    await page.goto(`http://localhost:${port}`);
    await page.waitForLoadState("networkidle");

    // 1. Navigate to Almanac (Dark)
    console.log("Capturing Almanac View (Dark)...");
    await page.click('button:has-text("Almanac")');
    await page.waitForTimeout(400);
    const almanacDarkPath = path.join(screenshotsDir, "almanac-dark.png");
    await page.screenshot({ path: almanacDarkPath });

    // 2. Switch to Light Theme
    console.log("Switching to Day Almanac Light Theme...");
    await page.click('button:has-text("Day almanac")');
    await page.waitForTimeout(400);

    // Capture Almanac (Light)
    console.log("Capturing Almanac View (Day Almanac Light)...");
    const almanacLightPath = path.join(screenshotsDir, "almanac-day-almanac.png");
    await page.screenshot({ path: almanacLightPath });

    // 3. Navigate to Search (Light)
    console.log("Capturing Search View (Day Almanac Light)...");
    await page.click('button:has-text("Search")');
    await page.waitForTimeout(400);

    // Type query in search
    const searchInput = await page.$('input[role="searchbox"]');
    if (searchInput) {
      await searchInput.fill("contrast");
      await page.waitForTimeout(300);
    }
    const searchLightPath = path.join(screenshotsDir, "search-day-almanac.png");
    await page.screenshot({ path: searchLightPath });

    // 4. Switch back to Dark Theme
    console.log("Switching to Dark Default Theme...");
    await page.click('button:has-text("Switch to Night")');
    await page.waitForTimeout(400);

    // Capture Search (Dark)
    console.log("Capturing Search View (Dark)...");
    const searchDarkPath = path.join(screenshotsDir, "search-dark.png");
    await page.screenshot({ path: searchDarkPath });

    console.log("F3 Screenshots captured successfully:");
    console.log(`- ${almanacDarkPath}`);
    console.log(`- ${almanacLightPath}`);
    console.log(`- ${searchDarkPath}`);
    console.log(`- ${searchLightPath}`);
  } catch (err) {
    console.error("Error capturing F3 screenshots:", err);
  } finally {
    await browser.close();
    server.close();
  }
});
