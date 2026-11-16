// Currency setting, the Maintenance overflow menu, backups with photos and
// files, the subscribable calendar feed, and dark-mode contrast.
// Run: node tests/features.mjs
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
const check = (ok, name, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); if (!ok) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Fake gist API.
const gists = new Map();
const gistCalls = [];
await ctx.route('https://api.github.com/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  gistCalls.push({ method: req.method(), path: url.pathname, auth: req.headers().authorization });
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body == null ? '' : JSON.stringify(body) });
  if (url.pathname === '/gists' && req.method() === 'POST') {
    const b = JSON.parse(req.postData());
    const id = `g${gists.size + 1}`;
    gists.set(id, b);
    return json(201, { id, owner: { login: 'me' } });
  }
  const m = /^\/gists\/(\w+)$/.exec(url.pathname);
  if (m && req.method() === 'PATCH') { gists.set(m[1], { ...gists.get(m[1]), ...JSON.parse(req.postData()) }); return json(200, { id: m[1] }); }
  if (m && req.method() === 'DELETE') { gists.delete(m[1]); return route.fulfill({ status: 204, body: '' }); }
  return json(404, { message: 'Not Found' });
});

await page.goto(`${BASE}#inventory`);
await page.waitForSelector('[data-tab=inventory]');
await page.evaluate(async () => {
  const { saveRecord } = await import('/js/sync.js');
  await saveRecord('items', { id: 'i1', name: 'Kettle', cost: 1234.5, serial: 'SN-SECRET-1', warrantyUntil: '2099-01-01', warrantyNotes: 'claim line 555' });
  await saveRecord('tasks', { id: 't1', name: 'Replace filter', every: 3, unit: 'months', notes: 'private note', parts: '16x25x1', firstDue: '2030-01-01', history: [] });
});

console.log('Currency');
await page.reload();
await page.waitForSelector('.data-table tbody tr');
check(/\$1,234\.50/.test(await page.textContent('.data-table')), 'defaults to US dollars');
await page.goto(`${BASE}#settings`);
await page.locator('summary', { hasText: 'Display' }).click();
await page.selectOption('select[aria-label="Currency"]', 'EUR');
await page.goto(`${BASE}#inventory`);
await page.waitForSelector('.data-table tbody tr');
const eur = await page.textContent('.data-table');
check(/€/.test(eur) && !/\$/.test(eur), 'switching to EUR relabels amounts', eur.slice(0, 120));
check(await page.evaluate(async () => (await import('/js/sync.js')).store.get('items')[0].cost) === 1234.5, 'the stored number is unchanged');

console.log('Overflow menu');
await page.goto(`${BASE}#maintenance`);
await page.waitForSelector('.toolbar.filters');
// Rows of toolbar controls, items within 8px of each other counting as one.
const rows = await page.evaluate(() => {
  const tops = [...document.querySelectorAll('.toolbar > *')].map((e) => e.getBoundingClientRect().top).sort((a, b) => a - b);
  return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 8).length;
});
check(rows === 2, `the toolbars take ${rows} rows at phone width (were 3)`);
check(!(await page.getByRole('menuitem', { name: 'Common tasks…' }).isVisible()), 'occasional actions are tucked away');
await page.getByRole('button', { name: 'More maintenance actions' }).click();
check(await page.getByRole('menuitem', { name: 'Common tasks…' }).isVisible(), 'and appear from the ⋯ menu');
await page.mouse.click(5, 5);
check(!(await page.getByRole('menuitem', { name: 'Common tasks…' }).isVisible()), 'a tap elsewhere closes it');
await page.getByRole('button', { name: 'More maintenance actions' }).click();
await page.getByRole('menuitem', { name: 'Common tasks…' }).click();
check(await page.locator('dialog[open] h2', { hasText: 'Common maintenance tasks' }).isVisible(), 'its items still work');
await page.keyboard.press('Escape');

console.log('Backup with photos & files');
const ids = await page.evaluate(async () => {
  const { photos, docs, saveRecord, store } = await import('/js/sync.js');
  const p = await photos.add({ mime: 'image/jpeg', data: 'UEhPVE8=', thumb: 'VEhVTUI=' });
  const f = await docs.add({ mime: 'application/pdf', data: 'TUFOVUFM', name: 'manual.pdf', size: 6 });
  const it = store.get('items').find((i) => i.id === 'i1');
  await saveRecord('items', { ...it, photoIds: [p], manuals: [{ id: 'm1', kind: 'file', fileId: f, name: 'manual.pdf', size: 6 }] });
  return { p, f };
});
await page.goto(`${BASE}#settings`);
await page.locator('summary', { hasText: 'Backup' }).click();
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup with photos & files' }).click()]);
const backup = JSON.parse(await fs.readFile(await dl.path(), 'utf8'));
check(/^home-backup-with-files-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), 'it downloads as a separate file', dl.suggestedFilename());
check(backup.attachments?.photos?.[ids.p]?.data === 'UEhPVE8=' && backup.attachments?.files?.[ids.f]?.name === 'manual.pdf', 'it carries the photo and the manual');
const [plain] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup', exact: true }).click()]);
check(!('attachments' in JSON.parse(await fs.readFile(await plain.path(), 'utf8'))), 'the plain backup stays records only');

// A fresh device: nothing here. Restoring brings the attachments back.
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => errors.push(e.message));
await p2.goto(`${BASE}#settings`);
await p2.locator('summary', { hasText: 'Backup' }).click();
await p2.locator('input[type=file][accept="application/json,.json"]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
await p2.locator('dialog.confirm').getByRole('button', { name: 'Replace' }).click();
await p2.waitForSelector('.toast:has-text("Backup restored")');
check(/restored 2 photos\/files/.test(await p2.textContent('.toast:has-text("Backup restored")')), 'restoring says what it put back', await p2.textContent('.toast:has-text("Backup restored")'));
const back = await p2.evaluate(async (i) => {
  const { photos, docs } = await import('/js/sync.js');
  return [(await photos.load(i.p))?.data, (await docs.load(i.f))?.name];
}, ids);
check(back[0] === 'UEhPVE8=' && back[1] === 'manual.pdf', 'and the photo and manual are there, under their own ids', JSON.stringify(back));
await ctx2.close();

console.log('Calendar feed');
await page.goto(`${BASE}#settings`);
await page.locator('summary', { hasText: 'Calendar feed' }).click();
check(/Anyone with the feed’s link can read it/.test(await page.textContent('details[data-section=calfeed]')), 'it says plainly who can read it');
check(gists.size === 0, 'nothing is published until asked');
await page.evaluate(() => localStorage.setItem('homeinv.pat', 'tok'));
await page.getByRole('button', { name: 'Publish calendar feed' }).click();
await page.waitForSelector('input[aria-label="Calendar feed URL"]');
const url = await page.inputValue('input[aria-label="Calendar feed URL"]');
check(url === 'https://gist.githubusercontent.com/me/g1/raw/home-maintenance.ics', 'it publishes a secret gist and shows its raw URL', url);
const g = gists.get('g1');
check(g.public === false, 'the gist is secret, not public');
const ics = g.files['home-maintenance.ics'].content;
check(/Replace filter/.test(ics) && /Kettle/.test(ics) && /16x25x1/.test(ics), 'the feed has the tasks and warranty dates');
check(!/private note/.test(ics) && !/SN-SECRET-1/.test(ics) && !/claim line/.test(ics), 'and leaves out notes, serials and warranty details');
check(gistCalls.every((c) => c.auth === 'Bearer tok') && !url.includes('tok'), 'the token goes in the header only, never in the URL');
check((await page.getAttribute('a:has-text("Subscribe in Calendar")', 'href')).startsWith('webcal://'), 'Subscribe opens the calendar app (webcal:)');
// Edits republish it by themselves.
await page.evaluate(async () => {
  const { saveRecord, store } = await import('/js/sync.js');
  await saveRecord('tasks', { ...store.get('tasks')[0], name: 'Replace furnace filter' });
});
await page.waitForFunction(() => true);
await page.waitForTimeout(9000);
check(/Replace furnace filter/.test(gists.get('g1').files['home-maintenance.ics'].content), 'an edit updates the feed a few seconds later');
await page.getByRole('button', { name: 'Stop feed' }).click();
await page.locator('dialog.confirm').getByRole('button', { name: 'Stop feed' }).click();
await page.waitForSelector('button:has-text("Publish calendar feed")');
check(!gists.has('g1'), 'stopping deletes the gist');

console.log('Dark mode');
const dark = await browser.newContext({ colorScheme: 'dark', serviceWorkers: 'block' });
const p3 = await dark.newPage();
await p3.goto(`${BASE}#breakers`);
await p3.waitForSelector('[data-tab=breakers]');
const contrast = await p3.evaluate(() => {
  const rgb = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const cr = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const probe = (cls, tag = 'span') => {
    const e = document.createElement(tag); e.className = cls; e.textContent = 'X'; document.body.append(e);
    const s = getComputedStyle(e); const r = cr(s.color, s.backgroundColor); e.remove(); return Math.round(r * 100) / 100;
  };
  return {
    overdue: probe('due-pill overdue'), soon: probe('due-pill soon'), later: probe('due-pill later'), ended: probe('due-pill ended'),
    count: probe('tab-count'), toast: probe('toast error', 'div'),
    gfci: probe('badge t-gfci'), afci: probe('badge t-afci'), hacr: probe('badge t-hacr'),
  };
});
const low = Object.entries(contrast).filter(([, v]) => v < 4.5);
check(!low.length, 'every due-pill, badge, count and error toast reaches 4.5:1 in dark mode', JSON.stringify(contrast));
await dark.close();

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} failure(s)` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
