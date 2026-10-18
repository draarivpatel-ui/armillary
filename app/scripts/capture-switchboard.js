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
    deviceScaleFactor: 2,
  });

  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForLoadState("networkidle");

    // 1. Navigate to Switchboard View
    console.log("Navigating to Switchboard...");
    await page.click('button:has-text("Switchboard")');
    await page.waitForTimeout(400);

    // 2. Capture Switchboard Side by Side (Dark)
    console.log("Capturing Switchboard Side by Side (Dark)...");
    const sbDarkPath = path.join(screenshotsDir, "switchboard-dark.png");
    await page.screenshot({ path: sbDarkPath });

    // 3. Switch to Server Matrix in Dark Theme
    console.log("Switching to Server Matrix (Dark)...");
    await page.click('button[role="tab"]:has-text("Server Matrix")');
    await page.waitForTimeout(300);
    const sbMatrixDarkPath = path.join(screenshotsDir, "switchboard-matrix-dark.png");
    await page.screenshot({ path: sbMatrixDarkPath });

    // 4. Switch to Day Almanac Light Theme
    console.log("Switching to Day Almanac Light Theme...");
    await page.click('button:has-text("Switch to Day almanac")');
    await page.waitForTimeout(300);

    // 5. Capture Server Matrix in Light Theme
    console.log("Capturing Switchboard Matrix (Day Almanac Light)...");
    const sbMatrixLightPath = path.join(screenshotsDir, "switchboard-matrix-day-almanac.png");
    await page.screenshot({ path: sbMatrixLightPath });

    // 6. Switch back to Side by Side in Light Theme
    console.log("Switching to Side by Side (Day Almanac Light)...");
    await page.click('button[role="tab"]:has-text("Side by Side")');
    await page.waitForTimeout(300);
    const sbLightPath = path.join(screenshotsDir, "switchboard-day-almanac.png");
    await page.screenshot({ path: sbLightPath });

    console.log("Screenshots captured successfully:");
    console.log(`- ${sbDarkPath}`);
    console.log(`- ${sbMatrixDarkPath}`);
    console.log(`- ${sbMatrixLightPath}`);
    console.log(`- ${sbLightPath}`);
  } catch (err) {
    console.error("Error capturing screenshots:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
});
