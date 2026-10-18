import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'screenshots');

async function main() {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Start Vite dev server on an ephemeral port
  const server = await createServer({
    root: rootDir,
    server: { port: 5199 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5199;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Vite server running at ${baseUrl}`);

  // Determine browser executable
  const chromePath =
    process.env.PLAYWRIGHT_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  let browser;
  try {
    if (fs.existsSync(chromePath)) {
      console.log(`Launching Chrome at ${chromePath}...`);
      browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else {
      console.log('Launching default Playwright chromium...');
      browser = await chromium.launch({ headless: true });
    }
  } catch (err) {
    console.error('Failed to launch browser with custom path, attempting standard launch:', err);
    browser = await chromium.launch({ headless: true });
  }

  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2, // HiDPI / Retina
  });

  const timestamps = [0, 2, 4, 6, 8];
  const themes = ['dark', 'light'];

  for (const theme of themes) {
    for (const timeSec of timestamps) {
      const url = `${baseUrl}/capture.html?theme=${theme}&time=${timeSec}&seed=42`;
      console.log(`Capturing ${theme} theme at ${timeSec}s: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle' });

      // Wait for capture ready flag
      await page.waitForFunction(() => window.__CAPTURE_READY__ === true);
      // Brief pause to ensure canvas flush
      await page.waitForTimeout(200);

      const filename = `orrery-${theme}-${timeSec}s.png`;
      const filePath = path.join(outDir, filename);

      const canvasElement = await page.$('#capture-canvas');
      if (canvasElement) {
        await canvasElement.screenshot({ path: filePath });
      } else {
        await page.screenshot({ path: filePath });
      }

      console.log(`Saved screenshot to ${filePath}`);
    }
  }

  await browser.close();
  await server.close();
  console.log('Capture sequence complete!');
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
