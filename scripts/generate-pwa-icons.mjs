// Run in the remote builder; reuse the existing product mark, no extra packages.
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '../upstream/buzz-app/node_modules/@playwright/test/index.mjs';
const root = new URL('../upstream/buzz-app/', import.meta.url);
const mark = await readFile(new URL('src/team/mark.svg', root), 'utf8');
await mkdir(new URL('public/pwa/', root), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0;background:white;display:grid;place-items:center;width:100vw;height:100vh}svg{width:64%;height:64%}</style>${mark}`);
    await page.screenshot({ path: new URL(`public/pwa/icon-${size}.png`, root).pathname });
  }
} finally { await browser.close(); }
