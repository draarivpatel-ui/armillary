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
  (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

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

    // Pre-populate some recent launches in localStorage for rich display
    await page.evaluate(() => {
      localStorage.setItem(
        "armillary:recent_launches",
        JSON.stringify([
          {
            id: "launch-recent-1",
            agentId: "claude",
            agentName: "Claude Code",
            family: "anthropic",
            projectFolder: "~/Projects/agent-hub",
            timestamp: Date.now() - 1000 * 60 * 35,
          },
          {
            id: "launch-recent-2",
            agentId: "codex",
            agentName: "Codex CLI",
            family: "openai",
            projectFolder: "~/Projects/armillary",
            timestamp: Date.now() - 1000 * 60 * 60 * 2,
          },
          {
            id: "launch-recent-3",
            agentId: "cursor",
            agentName: "Cursor CLI",
            family: "cursor",
            projectFolder: "~/Projects/example-app",
            timestamp: Date.now() - 1000 * 60 * 60 * 18,
          },
        ])
      );
    });

    // ==========================================
    // 1. ALMANAC (Dark & Light)
    // ==========================================
    console.log("Navigating to Almanac...");
    await page.click('button:has-text("Almanac")');
    await page.waitForTimeout(400);

    console.log("Capturing Almanac View (Dark)...");
    await page.screenshot({ path: path.join(screenshotsDir, "almanac-dark.png") });

    // Open Date Range Picker Popover in Dark theme
    console.log("Opening Date Range popover...");
    await page.click('button.obs-date-range-trigger');
    await page.waitForTimeout(300);
    console.log("Capturing Almanac Date Range Popover (Dark)...");
    await page.screenshot({ path: path.join(screenshotsDir, "almanac-popover-dark.png") });

    // Close popover by clicking outside or escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Switch to Light Theme
    console.log("Switching to Day Almanac Light Theme...");
    await page.click('button:has-text("Day almanac")');
    await page.waitForTimeout(400);

    console.log("Capturing Almanac View (Day Almanac Light)...");
    await page.screenshot({ path: path.join(screenshotsDir, "almanac-day-almanac.png") });

    // Open Date Range Picker Popover in Light theme
    console.log("Opening Date Range popover (Light)...");
    await page.click('button.obs-date-range-trigger');
    await page.waitForTimeout(300);
    console.log("Capturing Almanac Date Range Popover (Day Almanac Light)...");
    await page.screenshot({ path: path.join(screenshotsDir, "almanac-popover-day-almanac.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ==========================================
    // 2. SEARCH (Dark & Light)
    // ==========================================
    console.log("Navigating to Search (Day Almanac Light)...");
    await page.click('button:has-text("Search")');
    await page.waitForTimeout(400);

    const searchInput = await page.$('input[role="searchbox"]');
    if (searchInput) {
      await searchInput.fill("contrast");
      await page.waitForTimeout(400);
    }

    console.log("Capturing Search View (Day Almanac Light)...");
    await page.screenshot({ path: path.join(screenshotsDir, "search-day-almanac.png") });

    // Switch back to Dark Theme
    console.log("Switching to Dark Default Theme...");
    await page.click('button:has-text("Switch to Night")');
    await page.waitForTimeout(400);

    console.log("Capturing Search View (Dark)...");
    await page.screenshot({ path: path.join(screenshotsDir, "search-dark.png") });

    // ==========================================
    // 3. LAUNCHPAD (Dark & Light)
    // ==========================================
    console.log("Navigating to Launchpad (Dark)...");
    await page.click('button:has-text("Launchpad")');
    await page.waitForTimeout(400);

    console.log("Capturing Launchpad View with Recent Launches & Help Card (Dark)...");
    await page.screenshot({ path: path.join(screenshotsDir, "launchpad-dark.png") });

    // Switch to Light Theme
    console.log("Switching to Day Almanac Light Theme for Launchpad...");
    await page.click('button:has-text("Day almanac")');
    await page.waitForTimeout(400);

    console.log("Capturing Launchpad View with Recent Launches & Help Card (Day Almanac Light)...");
    await page.screenshot({ path: path.join(screenshotsDir, "launchpad-day-almanac.png") });

    // Switch back to Dark Theme
    await page.click('button:has-text("Switch to Night")');
    await page.waitForTimeout(300);

    console.log("All FX4 screenshots captured successfully!");
  } catch (err) {
    console.error("Error capturing screenshots:", err);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
