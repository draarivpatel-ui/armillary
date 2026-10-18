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

const executablePath = process.env.CHROME_PATH || undefined;

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
    console.warn("Could not launch default chromium, trying system channels...", e.message);
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ channel: "msedge", headless: true });
    }
  }

  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });

  try {
    await page.goto(`http://localhost:${port}`);
    await page.waitForLoadState("networkidle");

    // Navigate to Launchpad
    console.log("Navigating to Launchpad...");
    await page.click('button:has-text("Launchpad")');
    await page.waitForTimeout(400);

    // 1. Capture Launchpad initial configuration in Dark theme
    console.log("Capturing Launchpad (Dark)...");
    const launchpadDarkPath = path.join(screenshotsDir, "launchpad-dark.png");
    await page.screenshot({ path: launchpadDarkPath });

    // 2. Launch an agent session (clicks Launch Agent)
    console.log("Launching agent session in browser preview...");
    await page.click('button:has-text("Launch Agent")');
    await page.waitForTimeout(500);

    // Capture Launchpad with terminal in Dark theme
    console.log("Capturing Launchpad terminal (Dark)...");
    const terminalDarkPath = path.join(screenshotsDir, "launchpad-terminal-dark.png");
    await page.screenshot({ path: terminalDarkPath });

    // 3. Switch to Day Almanac light theme
    console.log("Switching to Day Almanac Light Theme...");
    await page.click('button:has-text("Day almanac")');
    await page.waitForTimeout(400);

    // Capture Launchpad with terminal in Light theme
    console.log("Capturing Launchpad terminal (Day Almanac Light)...");
    const terminalLightPath = path.join(screenshotsDir, "launchpad-terminal-day-almanac.png");
    await page.screenshot({ path: terminalLightPath });

    // 4. Click New Terminal to show configuration in Light theme
    console.log("Showing New Terminal configuration in Light theme...");
    await page.click('button:has-text("New Terminal")');
    await page.waitForTimeout(400);
    const launchpadLightPath = path.join(screenshotsDir, "launchpad-day-almanac.png");
    await page.screenshot({ path: launchpadLightPath });

    console.log("Screenshots captured successfully:");
    console.log(`- ${launchpadDarkPath}`);
    console.log(`- ${terminalDarkPath}`);
    console.log(`- ${terminalLightPath}`);
    console.log(`- ${launchpadLightPath}`);
  } catch (err) {
    console.error("Error capturing screenshots:", err);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
