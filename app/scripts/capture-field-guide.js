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

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });

  try {
    await page.goto(`http://localhost:${port}`);
    await page.waitForLoadState("networkidle");

    // 1. Navigate to Field Guide view (button 'Field Guide' in rail)
    console.log("Navigating to Field Guide View...");
    await page.click('button:has-text("Field Guide")');
    await page.waitForTimeout(400);

    // 2. Capture Field Guide in Dark Theme
    console.log("Capturing Field Guide (Dark Theme)...");
    const darkPath = path.join(screenshotsDir, "field-guide-dark.png");
    await page.screenshot({ path: darkPath });

    // 3. Switch to Light Theme
    console.log("Switching to Light Theme...");
    await page.click('button:has-text("Day Almanac")');
    await page.waitForTimeout(400);

    // 4. Capture Field Guide in Light Theme
    console.log("Capturing Field Guide (Day Almanac Light)...");
    const lightPath = path.join(screenshotsDir, "field-guide-light.png");
    await page.screenshot({ path: lightPath });

    // 5. Test "Installed only" filter in Light Theme
    console.log("Applying Installed Only filter...");
    await page.click('input[type="checkbox"]');
    await page.waitForTimeout(300);
    const filterPath = path.join(screenshotsDir, "field-guide-installed-only.png");
    await page.screenshot({ path: filterPath });

    // 6. Test Search input
    console.log("Typing search query...");
    await page.click('button:has-text("Switch to Night")'); // switch back to dark for search
    await page.waitForTimeout(300);
    await page.fill('input[role="searchbox"]', "Claude");
    await page.waitForTimeout(300);
    const searchPath = path.join(screenshotsDir, "field-guide-search.png");
    await page.screenshot({ path: searchPath });

    console.log("Field Guide screenshots captured successfully:");
    console.log(`- ${darkPath}`);
    console.log(`- ${lightPath}`);
    console.log(`- ${filterPath}`);
    console.log(`- ${searchPath}`);
  } catch (err) {
    console.error("Error capturing screenshots:", err);
  } finally {
    await browser.close();
    server.close();
  }
});
