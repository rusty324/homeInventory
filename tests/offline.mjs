// The app opens with no connection (sw.js). Run: node tests/offline.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/html' }).end(await fs.readFile(path.join(ROOT, p === '/' ? 'index.html' : p)));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let failed = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE);
await page.evaluate(() => new Promise((resolve) => {
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'precached') resolve(); });
}));
await page.reload();
check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page');
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('[data-tab=inventory]', { timeout: 15000 }).catch(() => {});
check((await page.locator('[data-tab]').count()) >= 5, 'the app opens with no connection');
await page.click('[data-tab=maintenance]');
await page.getByRole('button', { name: '+ Task' }).waitFor({ timeout: 5000 }).catch(() => {});
check(await page.getByRole('button', { name: '+ Task' }).isVisible(), 'and its tabs work');
check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
server.close();
console.log(failed ? `\n${failed} failure(s)` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
