// Attachments are only deleted once nothing points at them: a form deletes
// removed photos/files after the record is saved (and none if the save
// fails), and restoring a backup deletes the ones only the replaced records
// used. Run: node tests/attachments.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}#inventory`);
await page.waitForSelector('[data-tab=inventory]');

const dialog = () => page.locator('dialog[open]').last();
// A tiny valid JPEG-ish payload is enough: nothing decodes it until it is shown.
const has = (kind, id) => page.evaluate(async ([k, i]) => {
  const s = await import('/js/sync.js');
  return !!(await s[k].load(i));
}, [kind, id]);

// An item with two photos and an uploaded manual, stored directly.
const ids = await page.evaluate(async () => {
  const { photos, docs, saveRecord } = await import('/js/sync.js');
  const blob = { mime: 'image/jpeg', data: 'AAAA', thumb: 'AAAA' };
  const p1 = await photos.add(blob);
  const p2 = await photos.add(blob);
  const f1 = await docs.add({ mime: 'application/pdf', data: 'AAAA', name: 'm.pdf', size: 3 });
  await saveRecord('items', { id: 'it1', name: 'Kettle', photoIds: [p1, p2], manuals: [{ id: 'd1', kind: 'file', name: 'm.pdf', size: 3, fileId: f1, label: '' }] });
  return { p1, p2, f1 };
});
await page.reload();
await page.waitForSelector('.data-table tbody tr');

console.log('A save that fails deletes nothing');
const openKettle = async () => { await page.locator('.data-table tbody tr', { hasText: 'Kettle' }).click(); await dialog().waitFor(); };
await openKettle();
await dialog().locator('.photo-tile .photo-x').first().click();
await dialog().locator('.doc-row .icon-btn').first().click();
// Storage full: the record can't be saved.
await page.evaluate(() => {
  const real = Storage.prototype.setItem;
  window.__roomy = () => { Storage.prototype.setItem = real; };
  Storage.prototype.setItem = function (k, v) {
    if (k.startsWith('homeinv.data.')) throw new DOMException('full', 'QuotaExceededError');
    return real.call(this, k, v);
  };
});
await dialog().getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(600);
await page.evaluate(() => window.__roomy());
const stored = await page.evaluate(async () => (await import('/js/sync.js')).store.get('items').find((i) => i.id === 'it1'));
check(stored.photoIds.length === 2 && stored.manuals.length === 1, 'the record is unchanged', JSON.stringify(stored));
check(await has('photos', ids.p1) && await has('photos', ids.p2), 'and both of its photos still exist');
check(await has('docs', ids.f1), 'and so does its manual');
check(await page.locator('dialog[open]').count() === 1, 'the form stays open to try again');

console.log('A save that succeeds deletes what was removed, after saving');
await dialog().getByRole('button', { name: 'Save' }).click();
await page.waitForFunction(() => !document.querySelector('dialog[open]'));
await page.waitForTimeout(300);
const saved = await page.evaluate(async () => (await import('/js/sync.js')).store.get('items').find((i) => i.id === 'it1'));
check(saved.photoIds.length === 1 && saved.manuals.length === 0, 'the record drops the removed photo and manual', JSON.stringify(saved));
check(!(await has('photos', ids.p1)) && await has('photos', ids.p2), 'only the removed photo is deleted');
check(!(await has('docs', ids.f1)), 'and the removed manual');

console.log('A new photo uploaded by a failed save is cleaned up');
const before = await page.evaluate(async () => {
  const { photos } = await import('/js/sync.js');
  return (await photos.pending?.()) ?? null;
});
await openKettle();
await dialog().locator('input[type=file][accept="image/*"]').setInputFiles({
  name: 'p.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
});
await dialog().locator('.photo-tile').nth(1).waitFor();
await page.evaluate(() => {
  const real = Storage.prototype.setItem;
  window.__roomy = () => { Storage.prototype.setItem = real; };
  window.__added = [];
  Storage.prototype.setItem = function (k, v) {
    if (k.startsWith('homeinv.data.')) throw new DOMException('full', 'QuotaExceededError');
    return real.call(this, k, v);
  };
});
// Watch what gets added and removed while the save fails.
await page.evaluate(async () => {
  const { photos } = await import('/js/sync.js');
  const add = photos.add; const rm = photos.remove;
  window.__log = [];
  photos.add = async (p) => { const id = await add(p); window.__log.push(['add', id]); return id; };
  photos.remove = async (id) => { window.__log.push(['remove', id]); return rm(id); };
});
await dialog().getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);
await page.evaluate(() => window.__roomy());
const log = await page.evaluate(() => window.__log);
const added = log.filter(([k]) => k === 'add').map(([, i]) => i);
check(added.length === 1 && log.some(([k, i]) => k === 'remove' && i === added[0]), 'the photo it uploaded is removed again', JSON.stringify(log));
check(!log.some(([k, i]) => k === 'remove' && i === ids.p2), 'the photo the record keeps is not touched');
await page.keyboard.press('Escape');
await page.locator('dialog.confirm').getByRole('button', { name: 'Discard' }).click().catch(() => {});
void before;

console.log('Restoring a backup removes attachments only the replaced records used');
const r = await page.evaluate(async () => {
  const { photos, docs, saveRecord } = await import('/js/sync.js');
  const blob = { mime: 'image/jpeg', data: 'AAAA', thumb: 'AAAA' };
  const keep = await photos.add(blob); // used before and after
  const drop = await photos.add(blob); // used only before
  const dropFile = await docs.add({ mime: 'application/pdf', data: 'AAAA', name: 'x.pdf', size: 3 });
  await saveRecord('items', { id: 'it2', name: 'Drill', photoIds: [keep, drop], manuals: [{ id: 'd2', kind: 'file', fileId: dropFile, name: 'x.pdf', size: 3 }] });
  await saveRecord('paints', { id: 'pa1', colorName: 'White', photoIds: [] });
  return { keep, drop, dropFile };
});
const backup = { app: 'homeinv', version: 1, collections: { items: [{ id: 'it2', name: 'Drill', photoIds: [r.keep], manuals: [] }], paints: [{ id: 'pa1', colorName: 'White', photoIds: [] }] } };
await page.goto(`${BASE}#settings`);
await page.locator('summary', { hasText: 'Backup' }).click();
await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
await page.locator('dialog.confirm').getByRole('button', { name: 'Replace' }).click();
await page.waitForSelector('.toast:has-text("Backup restored")');
check(/removed 3 attachments/.test(await page.textContent('.toast:has-text("Backup restored")')), 'it says how many it removed', await page.textContent('.toast:has-text("Backup restored")'));
check(await has('photos', r.keep), 'a photo the restored records use is kept');
check(!(await has('photos', r.drop)), 'a photo only the old records used is deleted');
check(!(await has('docs', r.dropFile)), 'and so is such a file');
check(!(await has('photos', ids.p2)), 'the Kettle (not in the backup) loses its photo too');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} failure(s)` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
