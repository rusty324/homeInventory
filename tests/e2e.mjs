// End-to-end test: drives the real page in Chromium with api.github.com
// stubbed by an in-memory repo. Run: node tests/e2e.mjs
// (needs the `playwright` package; set CHROMIUM_PATH to use a specific binary).
//
// Covers the ghsync guarantees (nothing leaves the browser before a repo and
// token exist; every request targets the data repo; offline writes queue and
// flush; 409s merge; encrypted files carry no plaintext) plus the three tools.

import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'me';
const REPO = 'home-data';
// Sync into a nested folder with a space, so path mapping and URL encoding are
// exercised by every sync check below.
const DIR = 'records/my home';
let PUBLIC = false; // flipped at the end to check the public-repo warning
let FAIL_PUTS = false; // make every write fail with a 500, to check failures are reported

// ---------- static server ----------
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

// ---------- fake GitHub ----------
const repo = new Map(); // path -> { content(base64), sha }
const calls = [];
const shaOf = (b64) => crypto.createHash('sha1').update(b64).digest('hex');
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');

// An exception in a route handler leaves the request pending forever, so
// report it and answer 500 instead of letting the page hang.
async function github(route) {
  try {
    await fakeGithub(route);
  } catch (e) {
    console.log(`  ! route handler error: ${e.stack}`);
    failures++;
    await route.fulfill({ status: 500, body: '' }).catch(() => {});
  }
}

async function fakeGithub(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  calls.push({ method, path: url.pathname, body, accept: req.headers().accept });
  const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  if (req.headers().authorization !== 'Bearer tok123') return json(401, { message: 'Bad credentials' });
  const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/.exec(url.pathname);
  if (!m || m[1] !== OWNER || m[2] !== REPO) return json(404, { message: 'Not Found' });
  const p = m[3] === undefined ? undefined : decodeURIComponent(m[3]);
  if (p === undefined) return json(200, { full_name: `${OWNER}/${REPO}`, private: !PUBLIC });
  if (method === 'GET') {
    if (repo.has(p)) {
      const f = repo.get(p);
      const size = Buffer.from(f.content, 'base64').length;
      // Like the real API: files over 1 MB only come back via the raw media type.
      if (req.headers().accept === 'application/vnd.github.raw+json') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(f.content, 'base64') });
      if (size > 1024 * 1024) return json(200, { name: p.split('/').pop(), path: p, sha: f.sha, size, content: '', encoding: 'none' });
      return json(200, { name: p.split('/').pop(), path: p, sha: f.sha, size, content: f.content, encoding: 'base64' });
    }
    const kids = [...repo.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'));
    if (kids.length) return json(200, kids.map(([k, f]) => ({ name: k.split('/').pop(), path: k, sha: f.sha, type: 'file' })));
    return json(404, { message: 'Not Found' });
  }
  if (method === 'PUT') {
    if (FAIL_PUTS) return json(500, { message: 'Server Error' });
    const cur = repo.get(p);
    if (cur && body.sha !== cur.sha) return json(409, { message: 'sha mismatch' });
    if (!cur && body.sha) return json(409, { message: 'no such file' });
    const sha = shaOf(body.content + Date.now() + Math.random());
    repo.set(p, { content: body.content, sha });
    return json(cur ? 200 : 201, { content: { sha, path: p } });
  }
  if (method === 'DELETE') {
    const cur = repo.get(p);
    if (!cur) return json(404, { message: 'Not Found' });
    if (body.sha !== cur.sha) return json(409, { message: 'sha mismatch' });
    repo.delete(p);
    return json(200, { commit: {} });
  }
  return json(405, {});
}

// ---------- harness ----------
let failures = 0;
const logs = [];
const T0 = Date.now();
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
    if (logs.length) console.log(logs.splice(0).map((l) => `      | ${l}`).join('\n'));
  }
}
const step = (s) => { logs.length = 0; console.log(`\n${s}`); };
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

let deviceN = 0;
async function newDevice() {
  const ctxName = `dev${++deviceN}`;
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.route('https://api.github.com/**', github);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { // Chrome logs every non-2xx fetch; 404/409 are expected protocol here.
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().startsWith('Failed to load resource')
      && !m.text().includes('GitHub API 500') /* injected deliberately via FAIL_PUTS */) errors.push(m.text()); logs.push(`${((Date.now() - T0) / 1000).toFixed(2)} ${ctxName} ${m.type()}: ${m.text()}`.slice(0, 300)); if (process.env.DEBUG) console.log('[page]', m.type(), m.text()); });
  await page.addInitScript(() => {
    window.__printed = 0;
    window.print = () => { window.__printed++; };
    // Record toasts so a failing check can show what the app said.
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && console.info(`toast: ${n.textContent}`))))
        .observe(document.body, { childList: true, subtree: true });
    });
  });
  await page.goto(BASE);
  return { ctx, page, errors };
}

// A noisy image so the JPEG is large (exercises chunked base64 past ~100 KB).
async function noisyPng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1400; c.height = 1000;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name: 'swatch.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(1_600_000)]);
const dialog = (page) => page.locator('dialog[open]').last();
const fieldIn = (page, label) => dialog(page).locator('.field', { has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) });

try {
  const A = await newDevice();
  const { page } = A;

  step('Home screen icon');
  // Every icon the page and manifest point at must load and be the size it claims.
  const iconCheck = await page.evaluate(async () => {
    const size = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(`${i.naturalWidth}x${i.naturalHeight}`); i.onerror = () => res('error'); i.src = src; });
    const touch = document.querySelector('link[rel=apple-touch-icon]').href;
    const manifestUrl = document.querySelector('link[rel=manifest]').href;
    const manifest = await (await fetch(manifestUrl)).json();
    const icons = await Promise.all(manifest.icons.map(async (ic) => ({ ...ic, got: await size(new URL(ic.src, manifestUrl).href) })));
    return { touch: await size(touch), standalone: manifest.display, startUrl: manifest.start_url, icons,
      capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content };
  });
  check(iconCheck.touch === '180x180', `apple-touch-icon is 180×180 (${iconCheck.touch})`);
  check(iconCheck.icons.every((ic) => ic.got !== 'error' && (ic.sizes === 'any' || ic.sizes === ic.got)), `manifest icons load at their declared sizes (${iconCheck.icons.map((i) => `${i.src}=${i.got}`).join(', ')})`);
  check(iconCheck.standalone === 'standalone' && iconCheck.startUrl === './' && iconCheck.capable === 'yes', 'opens standalone from the home screen');

  step('Local-only mode');
  check(await page.locator('#badge').textContent() === 'local only', 'badge says local only');
  await page.waitForTimeout(300);
  check(calls.length === 0, 'no request to GitHub without a repo and token');

  step('Paint logger');
  await page.getByRole('button', { name: '+ Add your first paint' }).click();
  await fieldIn(page, 'Color name').locator('input').fill('Agreeable Gray');
  await fieldIn(page, 'Color code').locator('input').fill('SW 7029');
  await fieldIn(page, 'Brand').locator('input').fill('Sherwin-Williams');
  await fieldIn(page, 'Sheen').locator('select').selectOption('Eggshell');
  await fieldIn(page, 'Color family').locator('select').selectOption('Grays');
  // New room inline from the assignment row
  await dialog(page).locator('.use-row select').first().selectOption('__new__');
  await fieldIn(page, 'Name').locator('input').fill('Living Room');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.use-row .suggest input').first().fill('Walls');
  await page.locator('dialog[open] input[type=file]').setInputFiles(await noisyPng(page));
  await page.locator('dialog[open] .photo-tile').first().waitFor();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.paint-card').first().waitFor();
  check(await page.locator('.paint-card').count() === 1, 'paint card rendered');
  check((await page.locator('.paint-card').textContent()).includes('Living Room — Walls'), 'room/area chip shown');
  check(await until(async () => (await page.locator('.paint-card .thumb-wrap img[src^="data:"]').count()) === 1), 'photo thumbnail shown');

  // second paint for search tests
  await page.getByRole('button', { name: '+ Paint' }).click();
  await fieldIn(page, 'Color name').locator('input').fill('Hale Navy');
  await fieldIn(page, 'Brand').locator('input').fill('Benjamin Moore');
  await dialog(page).locator('input[type=color]').fill('#2e3a4f');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.paint-card').nth(1).waitFor();
  await page.getByPlaceholder('Search color, code, brand, room…').fill('living');
  check(await page.locator('.paint-card').count() === 1, 'search by room finds one paint');
  await page.getByPlaceholder('Search color, code, brand, room…').fill('');
  await page.getByLabel('Filter by color family').selectOption('Blues');
  check((await page.locator('.paint-card').textContent()).includes('Hale Navy'), 'family filter (auto from swatch) finds Hale Navy');
  await page.getByLabel('Filter by color family').selectOption('');
  await page.getByLabel('Filter by brand').selectOption('Sherwin-Williams');
  check(await page.locator('.paint-card').count() === 1, 'brand filter');
  await page.getByLabel('Filter by brand').selectOption('');
  await page.getByRole('tab', { name: 'By room' }).click();
  check((await page.locator('.room-block').first().textContent()).includes('Walls: Agreeable Gray'), 'by-room view lists paint');

  step('Breakers');
  await page.click('a[data-tab=breakers]');
  await page.getByRole('button', { name: '+ Add a panel' }).click();
  await fieldIn(page, 'Name').locator('input').fill('Main panel');
  await fieldIn(page, 'Spaces').locator('input').fill('20');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.panel-grid').waitFor();
  check(await page.locator('.slot-empty').count() === 20, '20 empty slots');
  // 2-pole at slot 1 (covers 1 and 3)
  await page.getByRole('button', { name: 'Add breaker in slot 1', exact: true }).click();
  await fieldIn(page, 'Poles').locator('select').selectOption('2');
  await fieldIn(page, 'Amps').locator('input').fill('30');
  await fieldIn(page, 'Label').locator('input').fill('Dryer');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.brk').first().waitFor();
  check(await page.locator('.slot-empty').count() === 18, '2-pole occupies two spaces');
  // tandem A/B at slot 2
  for (const [half, label] of [['A', 'Porch light'], ['B', 'Garage outlets']]) {
    await page.getByRole('button', { name: '+ Breaker' }).click();
    await fieldIn(page, 'Slot').locator('input').fill('2');
    await fieldIn(page, 'Tandem').locator('select').selectOption(half);
    await fieldIn(page, 'Type').locator('select').selectOption('GFCI');
    await fieldIn(page, 'Label').locator('input').fill(label);
    await fieldIn(page, 'Rooms').locator('select').selectOption({ label: 'Living Room' });
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(150);
  }
  check(await page.locator('.slot-fill.tandem .brk').count() === 2, 'tandem halves share one slot');
  check(await page.locator('.slot-empty').count() === 17, 'tandem uses one space');
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('living');
  check(await page.locator('.brk.hit').count() === 2 && await page.locator('.brk.dim').count() === 1, 'search highlights matching breakers');
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('');
  await page.getByRole('tab', { name: 'By room' }).click();
  check((await page.locator('.room-block').first().textContent()).includes('Porch light'), 'by-room view');
  await page.getByRole('tab', { name: 'Panel' }).click();
  await page.getByRole('button', { name: 'Print legend' }).click();
  await fieldIn(page, 'Paper').locator('select').selectOption('card46');
  check((await dialog(page).locator('.lg-preview .lg-table').textContent()).includes('Dryer'), 'legend preview');
  await dialog(page).getByRole('button', { name: 'Print / Save PDF' }).click();
  check(await page.evaluate(() => window.__printed) === 1, 'print invoked');
  check((await page.locator('#page-size').textContent()).includes('size: 4in 6in'), '@page sized to 4×6');
  check((await page.locator('#print-root td[rowspan="2"]').count()) >= 1, 'legend spans the 2-pole breaker');
  await page.keyboard.press('Escape');

  // Handle-tied single breakers: 8 ⛓ 10.
  await page.getByRole('button', { name: 'Add breaker in slot 8', exact: true }).click();
  const poleOpts = await fieldIn(page, 'Poles').locator('option').allTextContents();
  check(poleOpts.some((t) => t.includes('slots 8 + 10')), `Poles options name their slots (${poleOpts.join(' | ')})`);
  check((await dialog(page).locator('.tie-field').textContent()).includes('Handle-tied to breaker 10 below'), 'tie option names the breaker below');
  await dialog(page).locator('.tie-field input').check();
  await fieldIn(page, 'Label').locator('input').fill('Hall lights');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Add breaker in slot 10', exact: true }).click();
  check((await dialog(page).locator('.field', { hasText: 'Linked breakers' }).textContent()).includes('Breaker 8 above is handle-tied to this one'), 'lower breaker shows the tie from above');
  await fieldIn(page, 'Label').locator('input').fill('Hall outlets');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(150);
  check(await page.locator('.slot-fill.tie-down').count() === 1, 'panel map draws the tie between 8 and 10');
  check((await page.locator('.brk', { hasText: 'Hall lights' }).textContent()).includes('⛓ tied to 10')
    && (await page.locator('.brk', { hasText: 'Hall outlets' }).textContent()).includes('⛓ tied to 8'), 'both breakers say what they’re tied to');
  check(await page.locator('.slot-empty').count() === 15, 'tied breakers stay two separate single spaces');

  // Fixtures pinned to rooms: breaker 12 feeds Living Room and Kitchen, lights only in the Kitchen.
  await page.evaluate(async () => (await import('/js/sync.js')).store.upsert('rooms', { id: 'room-kitchen', name: 'Kitchen' }));
  await page.getByRole('button', { name: 'Add breaker in slot 12', exact: true }).click();
  await fieldIn(page, 'Label').locator('input').fill('Kitchen and living');
  await fieldIn(page, 'Rooms').locator('select').selectOption({ label: 'Living Room' });
  const fx = dialog(page).locator('.fixtures-editor');
  // Picked from the list, like rooms; each row then gets its own room.
  await fx.getByLabel('Add fixture').selectOption('Lights');
  await fx.getByLabel('Room for Lights').selectOption({ label: 'Kitchen' });
  await fx.getByLabel('Add fixture').selectOption('Outlets');
  check(await fx.locator('.fixture-row').count() === 2, 'two fixtures listed with their own room pickers');
  check(await fx.getByLabel('Room for Outlets').inputValue() === '', 'a newly added fixture defaults to all of the breaker’s rooms');
  const yours = await fx.getByLabel('Add fixture').locator('optgroup[label="Your fixtures"] option').allTextContents();
  check(yours.includes('Lights') && yours.includes('Outlets'), 'picking a common fixture adds it to your list');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(150);
  const saved12 = await page.evaluate(async () => (await import('/js/sync.js')).store.get('breakers').find((b) => b.label === 'Kitchen and living'));
  check(JSON.stringify(saved12.fixtures) === '[{"name":"Lights","roomId":"room-kitchen"},{"name":"Outlets","roomId":""}]', 'fixtures saved with their rooms');
  check(saved12.roomIds.includes('room-kitchen') && saved12.roomIds.length === 2, 'a fixture’s room is added to the breaker’s rooms');
  await page.getByRole('tab', { name: 'By room' }).click();
  const roomRow = (room) => page.locator('.room-block', { has: page.locator('h3', { hasText: new RegExp(`^${room}$`) }) }).locator('.list-row', { hasText: 'Kitchen and living' });
  const kitchenSub = await roomRow('Kitchen').locator('.row-sub').textContent();
  const livingSub = await roomRow('Living Room').locator('.row-sub').textContent();
  check(kitchenSub.includes('Lights') && kitchenSub.includes('Outlets'), `Kitchen lists both fixtures (${kitchenSub})`);
  check(!livingSub.includes('Lights') && livingSub.includes('Outlets'), `Living Room lists only the outlets (${livingSub})`);
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('lights kitchen');
  check(await page.locator('.list-row', { hasText: 'Kitchen and living' }).count() >= 1, 'search matches a fixture with its room');
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('');

  // Old records stored fixtures as plain strings: they must still read and display.
  await page.evaluate(async () => {
    const { store } = await import('/js/sync.js');
    const raw = JSON.parse(localStorage.getItem('homeinv.data.data/breakers.json'));
    raw.push({ id: 'legacy', panelId: raw[0].panelId, slot: 14, poles: 1, amps: 20, type: 'Standard', roomIds: [], fixtures: ['Dishwasher', 'Disposal'] });
    localStorage.setItem('homeinv.data.data/breakers.json', JSON.stringify(raw));
    store.emit({ type: 'changed', collection: 'breakers' });
  });
  await page.getByRole('tab', { name: 'List' }).click();
  check((await page.locator('.list-row', { hasText: 'Dishwasher' }).textContent()).includes('Dishwasher, Disposal'), 'legacy string fixtures still display');
  await page.locator('.list-row', { hasText: 'Dishwasher' }).click();
  check(await dialog(page).locator('.fixture-row').count() === 2, 'legacy fixtures open in the new editor');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(150);
  const legacyRaw = await page.evaluate(() => JSON.parse(localStorage.getItem('homeinv.data.data/breakers.json')).find((b) => b.id === 'legacy').fixtures);
  check(JSON.stringify(legacyRaw) === '[{"name":"Dishwasher","roomId":""},{"name":"Disposal","roomId":""}]', 'saving converts legacy fixtures to the new shape');
  // By fixture: one section per fixture, each breaker with the rooms it feeds that fixture in.
  await page.getByRole('tab', { name: 'By fixture' }).click();
  const fixtureHeads = await page.locator('.fixture-block h3').allTextContents();
  check(JSON.stringify(fixtureHeads) === '["Dishwasher","Disposal","Lights","Outlets"]', `a section per fixture, alphabetical (${fixtureHeads.join(', ')})`);
  const fxSub = (name) => page.locator('.fixture-block', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) }).locator('.row-sub').allTextContents();
  const lightsRows = await fxSub('Lights');
  check(lightsRows.length === 1 && lightsRows[0].includes('Kitchen') && !lightsRows[0].includes('Living Room'), `Lights: only the Kitchen (${lightsRows})`);
  const outletRows = await fxSub('Outlets');
  check(outletRows.length === 1 && outletRows[0].includes('Living Room') && outletRows[0].includes('Kitchen'), `Outlets: all of the breaker’s rooms (${outletRows})`);
  const unlistedBlock = page.locator('.room-block', { has: page.locator('h3', { hasText: 'No fixtures listed' }) });
  check((await unlistedBlock.textContent()).includes('Dryer'), 'breakers without fixtures are listed so they can be filled in');
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('lights kitchen');
  check(JSON.stringify(await page.locator('.results h3').allTextContents()) === '["Lights"]', 'search narrows to that fixture in that room');
  await page.getByPlaceholder('Find a breaker: room, fixture, label…').fill('');

  // "+ New fixture…" from inside a breaker, like "+ New room…".
  await page.getByRole('tab', { name: 'Panel' }).click();
  await page.locator('.brk', { hasText: 'Hall lights' }).click();
  await dialog(page).locator('.fixtures-editor').getByLabel('Add fixture').selectOption('__new__');
  await fieldIn(page, 'Name').locator('input').fill('Pendant lights');
  await fieldIn(page, 'Room').locator('select').selectOption({ label: 'Kitchen' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  check(await until(async () => (await dialog(page).locator('.fixture-row').allTextContents()).some((t) => t.includes('Pendant lights'))), 'a new fixture is created and added to the breaker');
  check(await dialog(page).getByLabel('Room for Pendant lights').inputValue() === 'room-kitchen', 'a room chosen for the new fixture carries onto the breaker');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(150);
  // Picking that fixture on another breaker starts it in its usual room.
  await page.locator('.brk', { hasText: 'Hall outlets' }).click();
  await dialog(page).locator('.fixtures-editor').getByLabel('Add fixture').selectOption('Pendant lights');
  check(await dialog(page).getByLabel('Room for Pendant lights').inputValue() === 'room-kitchen', 'an existing fixture starts in its usual room');
  await dialog(page).getByLabel('Room for Pendant lights').selectOption('');
  check(await dialog(page).getByLabel('Room for Pendant lights').inputValue() === '', '…and can still be changed per breaker');
  await page.keyboard.press('Escape');

  // Settings: the list, rename (updates breakers) and delete (removes from breakers).
  await page.click('[data-tab=settings]');
  await page.locator('summary', { hasText: 'Fixtures & loads' }).click();
  const fxSection = page.locator('details[data-section=fixtures]');
  const listed = await fxSection.locator('.row-title').allTextContents();
  check(['Dishwasher', 'Disposal', 'Lights', 'Outlets', 'Pendant lights'].every((n) => listed.includes(n)), `Settings lists your fixtures, including ones only used on breakers (${listed.join(', ')})`);
  check((await fxSection.locator('.list-row', { hasText: 'Pendant lights' }).locator('.row-sub').textContent()).includes('Kitchen'), 'the list shows a fixture’s usual room');
  await fxSection.locator('.list-row', { hasText: /^Lights/ }).click();
  check((await dialog(page).textContent()).includes('Used on 1 breaker'), 'the fixture editor says where it’s used');
  await fieldIn(page, 'Name').locator('input').fill('Ceiling lights');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  const renamed = await page.evaluate(async () => (await import('/js/sync.js')).store.get('breakers').find((b) => b.label === 'Kitchen and living').fixtures);
  check(JSON.stringify(renamed) === '[{"name":"Ceiling lights","roomId":"room-kitchen"},{"name":"Outlets","roomId":""}]', 'renaming a fixture updates the breakers using it (room kept)');
  await fxSection.locator('.list-row', { hasText: 'Disposal' }).click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  check((await dialog(page).textContent()).includes('removed from 1 breaker'), 'deleting a used fixture warns first');
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(200);
  const legacyNow = await page.evaluate(async () => (await import('/js/sync.js')).store.get('breakers').find((b) => b.id === 'legacy').fixtures.map((f) => f.name));
  check(JSON.stringify(legacyNow) === '["Dishwasher"]', 'deleting a fixture removes it from its breakers');
  check(!(await fxSection.locator('.row-title').allTextContents()).includes('Disposal'), 'and from the list');
  await page.click('[data-tab=breakers]');
  await page.getByRole('tab', { name: 'By fixture' }).click();
  check((await page.locator('.fixture-block h3').allTextContents()).includes('Ceiling lights'), 'By fixture shows the new name');
  await page.getByRole('tab', { name: 'Panel' }).click();

  await page.getByRole('button', { name: 'Print legend' }).click();
  check((await dialog(page).locator('.lg-preview').textContent()).includes('⛓ tied to 10'), 'legend shows the tie');
  await page.keyboard.press('Escape');

  step('Inventory');
  await page.click('a[data-tab=inventory]');
  for (const [name, cost] of [['TV', '899.99'], ['Drill', '129']]) {
    await page.getByRole('button', { name: '+ Item', exact: true }).click();
    await fieldIn(page, 'Name').locator('input').fill(name);
    await fieldIn(page, 'Purchase cost \\(\\$\\)').locator('input').fill(cost);
    await fieldIn(page, 'Room').locator('select').selectOption({ label: 'Living Room' });
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(150);
  }
  const names = async () => page.locator('.data-table tbody td.strong').allTextContents();
  check(JSON.stringify(await names()) === '["Drill","TV"]', 'sorted by name');
  await page.getByRole('button', { name: 'Cost' }).click();
  await page.getByRole('button', { name: /Cost/ }).click();
  check(JSON.stringify(await names()) === '["TV","Drill"]', 'sorted by cost descending');
  check((await page.locator('.totals').textContent()).includes('$1,028.99'), 'total cost');

  // Manuals: a link and an uploaded file > 1 MB (exercises the raw-media read later)
  await page.locator('.data-table tbody tr', { hasText: 'TV' }).click();
  const docsEd = dialog(page).locator('.docs-editor');
  await docsEd.getByLabel('Link URL').fill('javascript:alert(1)');
  await docsEd.getByRole('button', { name: 'Add link' }).click();
  check(await docsEd.locator('.doc-row').count() === 0, 'javascript: link rejected');
  await docsEd.getByLabel('Link URL').fill('example.com/tv-manual.pdf');
  await docsEd.getByLabel('Link label').fill('Owner manual');
  await docsEd.getByRole('button', { name: 'Add link' }).click();
  await docsEd.locator('input[type=file]').setInputFiles({ name: 'tv-guide.pdf', mimeType: 'application/pdf', buffer: PDF });
  await docsEd.locator('.doc-row').nth(1).waitFor();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  const tvDocs = page.locator('.data-table tbody tr', { hasText: 'TV' }).locator('.doc-link');
  check(await tvDocs.count() === 2, 'manuals column shows link and file');
  check(await tvDocs.first().getAttribute('href') === 'https://example.com/tv-manual.pdf', 'link normalised to https');
  // Headless Chromium has no PDF viewer, so the new tab turns the blob into a
  // download; a desktop browser renders it. Accept either.
  const [popup] = await Promise.all([A.ctx.waitForEvent('page'), tvDocs.nth(1).click()]);
  const pdfDl = popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  const opened = await until(() => popup.url().startsWith('blob:'), 8000) || (await pdfDl);
  const dlSize = opened?.path ? (await fs.stat(await opened.path())).size : null;
  check(opened && (dlSize === null || dlSize === PDF.length), `uploaded manual opens in a new tab (${popup.url().slice(0, 5)}, download ${dlSize})`);
  await popup.close();

  // Warranties: TV via the "+1 yr" quick fill, Drill ending in 20 days.
  const inDays = (n) => page.evaluate(async (k) => { const d = await import('/js/dates.js'); return d.addInterval(d.today(), k, 'days'); }, n);
  await page.locator('.data-table tbody tr', { hasText: 'TV' }).click();
  await dialog(page).getByRole('button', { name: '+1 yr' }).click();
  const tvUntil = await dialog(page).getByLabel('Warranty expires').inputValue();
  await fieldIn(page, 'Warranty details').locator('input').fill('LG extended plan #A123');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.locator('.data-table tbody tr', { hasText: 'Drill' }).click();
  await dialog(page).getByLabel('Warranty expires').fill(await inDays(20));
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  const expectTv = await page.evaluate(async () => { const d = await import('/js/dates.js'); return d.addInterval(d.today(), 1, 'years'); });
  check(tvUntil === expectTv, '+1 yr quick fill counts from today when there is no acquisition date');
  check((await page.locator('.data-table tbody tr', { hasText: 'Drill' }).locator('.due-pill').textContent()) === 'Ends in 20d', 'warranty column shows days left');
  await page.getByLabel('Filter by warranty').selectOption('soon');
  check(JSON.stringify(await page.locator('.data-table tbody td.strong').allTextContents()) === '["Drill"]', 'warranty filter: ending soon');
  await page.getByLabel('Filter by warranty').selectOption('');
  check(calls.length === 0, 'still nothing sent to GitHub');

  step('Maintenance');
  await page.click('a[data-tab=maintenance]');
  check(await page.evaluate(async () => {
    const m = await import('/js/maintenance.js');
    return m.addInterval('2025-01-31', 1, 'months') === '2025-02-28' && m.addInterval('2024-01-31', 1, 'months') === '2024-02-29'
      && m.addInterval('2024-02-29', 1, 'years') === '2025-02-28' && m.addInterval('2025-12-30', 1, 'weeks') === '2026-01-06';
  }), 'interval math clamps month ends');
  await page.getByRole('button', { name: 'Pick from common tasks' }).click();
  await dialog(page).locator('label.preset', { hasText: 'Replace HVAC air filter' }).locator('input').check();
  await dialog(page).locator('label.preset', { hasText: 'Drain / flush water heater' }).locator('input').check();
  await dialog(page).getByRole('button', { name: 'Add selected' }).click();
  await page.locator('.task-row').nth(1).waitFor();
  check(await page.locator('.group-soon .task-row').count() === 2, 'new preset tasks are due today');
  check((await page.locator('.group-soon .due-pill').first().textContent()) === 'Today', 'due pill says Today');
  const twoMonthsAgo = await page.evaluate(() => { const d = new Date(); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 10); });
  await page.getByRole('button', { name: '+ Task' }).click();
  await fieldIn(page, 'Task').locator('input').fill('Clean humidifier pad');
  await dialog(page).getByLabel('Every').fill('1');
  await dialog(page).getByLabel('Interval unit').selectOption('months');
  await fieldIn(page, 'Last done').locator('input').fill(twoMonthsAgo);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  check(await page.locator('.group-overdue .task-row').count() === 1, 'task last done 2 months ago on a monthly schedule is overdue');
  check((await page.locator('#overdue-count').textContent()) === '2', 'tab badge counts the overdue task and the warranty ending in 20 days');
  check((await page.locator('#overdue-count').getAttribute('title')).includes('1 warranty ending within 30 days'), 'badge tooltip explains the count');
  const wSection = page.locator('.group-warranty');
  check((await wSection.locator('.list-row').count()) === 1 && (await wSection.textContent()).includes('Drill'), 'Maintenance lists the warranty ending soon (not the one a year out)');
  await page.locator('.task-row', { hasText: 'HVAC' }).getByRole('button', { name: '✓ Done' }).click();
  await fieldIn(page, 'Cost \\(\\$\\)').locator('input').fill('24.50');
  await fieldIn(page, 'Note').locator('input').fill('16x25x1 MERV 8');
  await dialog(page).getByRole('button', { name: 'Log it' }).click();
  await page.waitForTimeout(200);
  check(await page.locator('.group-later .task-row', { hasText: 'HVAC' }).count() === 1, 'logging moves the task to Later');
  const expectDue = await page.evaluate(async () => { const m = await import('/js/maintenance.js'); const { shortDate } = await import('/js/ui.js'); return shortDate(m.addInterval(m.today(), 3, 'months')); });
  check((await page.locator('.task-row', { hasText: 'HVAC' }).locator('.due-pill').getAttribute('title')) === `Due ${expectDue}`, 'next due is 3 months out');
  // Link the water heater task to an item that has manuals
  await page.locator('.task-row', { hasText: 'water heater' }).click();
  await fieldIn(page, 'Inventory item').locator('select').selectOption({ label: 'TV' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  check(await page.locator('.task-row', { hasText: 'water heater' }).locator('.doc-link').count() === 2, 'task shows the linked item’s manuals');
  await page.getByRole('tab', { name: 'History' }).click();
  check((await page.locator('.results').textContent()).includes('$24.50'), 'history lists the logged cost');
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Calendar (.ics)' }).click()]);
  const ics = await fs.readFile(await dl.path(), 'utf8');
  check((ics.match(/BEGIN:VEVENT/g) || []).length === 5 && ics.includes('RRULE:FREQ=MONTHLY;INTERVAL=3'), 'calendar export has 3 recurring tasks + 2 warranty ends');
  const unfolded = ics.replace(/\r\n /g, '');
  check(unfolded.includes('SUMMARY:Warranty ends: TV') && unfolded.includes(`DTSTART;VALUE=DATE:${tvUntil.replace(/-/g, '')}`) && unfolded.includes('LG extended plan #A123'), 'warranty event on the expiry date with details');
  check((unfolded.match(/TRIGGER:-P30D/g) || []).length === 1, 'month-ahead alarm only where the end is more than 30 days out');
  check(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75) && ics.endsWith('END:VCALENDAR\r\n'), 'calendar lines folded per RFC 5545');
  check(calls.length === 0, 'still nothing sent to GitHub');

  step('Connect data repo');
  await page.click('a[data-tab=settings]');
  await page.locator('summary', { hasText: 'Data repository' }).click();
  const repoBody = page.locator('details[data-section=datarepo]');
  await repoBody.locator('input').nth(0).fill(OWNER);
  await repoBody.locator('input').nth(1).fill(REPO);
  await repoBody.getByLabel('Folder', { exact: true }).fill(` /${DIR}/ `);
  check((await repoBody.locator('.field', { hasText: 'Folder in the repo' }).textContent()).includes(`Files go in ${DIR}/, e.g. ${DIR}/inventory.json`), 'folder preview shows the normalised path');
  await repoBody.getByRole('button', { name: 'Save data repo' }).click();
  await page.locator('details[data-section=token] input[type=password]').fill('tok123');
  await page.locator('details[data-section=token]').getByRole('button', { name: 'Save token' }).click();
  await until(() => page.locator('details[data-section=datarepo] button', { hasText: 'Upload all local data' }).isEnabled());
  await page.locator('details[data-section=datarepo]').getByRole('button', { name: 'Upload all local data' }).click();
  await until(() => repo.size >= 6);
  await until(() => [...repo.keys()].some((k) => k.startsWith(`${DIR}/files/`)));
  check(['rooms', 'paints', 'panels', 'breakers', 'inventory', 'maintenance'].every((n) => repo.has(`${DIR}/${n}.json`)), 'every collection uploaded');
  check([...repo.keys()].some((k) => k.startsWith(`${DIR}/files/`)), 'uploaded manual stored as its own file');
  check([...repo.keys()].some((k) => k.startsWith(`${DIR}/photos/`)), 'photo uploaded as its own file');
  check([...repo.keys()].every((k) => k.startsWith(`${DIR}/`)), 'nothing written outside the chosen folder');
  check(calls.every((c) => c.path.startsWith(`/repos/${OWNER}/${REPO}`)), 'every request targets the data repo');
  const inv = JSON.parse(decode(repo.get(`${DIR}/inventory.json`).content));
  check(inv.length === 2 && inv.some((i) => i.name === 'TV'), 'inventory content correct');
  await until(async () => (await page.locator('#badge').textContent()) === 'synced');
  check(await page.locator('#badge').textContent() === 'synced', 'badge says synced');

  step('Encryption');
  await page.locator('summary', { hasText: 'Privacy' }).click();
  await page.locator('details[data-section=privacy] input[type=password]').fill('hunter2');
  await page.locator('details[data-section=privacy]').getByRole('button', { name: 'Enable encryption' }).click();
  await until(() => [...repo.values()].every((f) => decode(f.content).includes('ft-encrypted')), 15000);
  const plain = [...repo.entries()].filter(([, f]) => !decode(f.content).includes('ft-encrypted')).map(([k]) => k);
  check(plain.length === 0, `all files encrypted (plaintext: ${plain.join(', ') || 'none'})`);
  check(![...repo.values()].some((f) => /Agreeable Gray|"label": "Dryer"|"name": "TV"/.test(decode(f.content))), 'no plaintext in the repo');
  const photoPath = [...repo.keys()].find((k) => k.startsWith(`${DIR}/photos/`));
  check(decode(repo.get(photoPath).content).length > 150000, 'large encrypted photo written (chunked base64 OK)');

  step('Second device');
  const B = await newDevice();
  await B.page.evaluate(({ o, r, d }) => {
    localStorage.setItem('homeinv.datarepo', JSON.stringify({ owner: o, repo: r, branch: 'main', dir: d }));
    localStorage.setItem('homeinv.pat', 'tok123');
    localStorage.setItem('homeinv.enc.pw', 'hunter2');
  }, { o: OWNER, r: REPO, d: DIR });
  await B.page.reload();
  check(await until(async () => (await B.page.locator('.paint-card').count()) === 2, 10000), 'paints synced to device B');
  const t0 = Date.now();
  // Check the poll's own result: re-querying afterwards races re-renders.
  const seen = await until(async () => (await B.page.locator('.paint-card img[src^="data:"]').count()) === 1, 30000);
  if (process.env.DEBUG) console.log(`photo visible after ${Date.now() - t0} ms`);
  check(seen, 'photo downloaded and decrypted on device B');
  const bDoc = await B.page.evaluate(async () => {
    const { store, docs } = await import('/js/sync.js');
    const tv = store.get('items').find((i) => i.name === 'TV');
    const f = tv?.manuals?.find((d) => d.kind === 'file');
    return f ? (await docs.blob(f.fileId))?.size : null;
  });
  check(bDoc === PDF.length, `manual (>1 MB, encrypted) readable on device B (${bDoc} bytes)`);
  check(calls.some((c) => c.accept === 'application/vnd.github.raw+json'), 'large file read through the raw media type');
  check(await B.page.evaluate(async () => (await import('/js/sync.js')).store.get('tasks').length) === 3, 'maintenance tasks synced to device B');

  step('Offline queue');
  await A.page.click('a[data-tab=inventory]');
  await A.ctx.setOffline(true);
  const before = calls.length;
  await A.page.getByRole('button', { name: '+ Item' }).click();
  await fieldIn(A.page, 'Name').locator('input').fill('Ladder');
  await dialog(A.page).getByRole('button', { name: 'Save' }).click();
  await A.page.waitForTimeout(300);
  check(calls.slice(before).every((c) => c.method === 'GET'), 'no write while offline');
  check(await A.page.locator('#badge').textContent() === 'pending sync', 'badge says pending');
  await A.ctx.setOffline(false);
  await until(async () => JSON.stringify(repo.get(`${DIR}/inventory.json`)).length && (await A.page.locator('#badge').textContent()) === 'synced');
  check(await A.page.locator('#badge').textContent() === 'synced', 'queued write flushed on reconnect');

  step('Conflict merge');
  // Device B writes inventory with a stale sha (A changed it since B loaded).
  await B.page.click('a[data-tab=inventory]');
  await B.page.getByRole('button', { name: '+ Item' }).click();
  await fieldIn(B.page, 'Name').locator('input').fill('Bike');
  await dialog(B.page).getByRole('button', { name: 'Save' }).click();
  await until(async () => (await B.page.locator('#badge').textContent()) === 'synced');
  const merged = await A.page.evaluate(async () => {
    const { store } = await import('/js/sync.js');
    const files = await store.client.getFile('data/inventory.json');
    const res = await store.deserializeFile('data/inventory.json', JSON.parse(files.content));
    return res.data.map((i) => i.name).sort();
  });
  check(JSON.stringify(merged) === '["Bike","Drill","Ladder","TV"]', `409 merged both sides by id (${merged})`);

  step('Upload all over legacy null files');
  // Older versions seeded never-used collections as the literal "null". A
  // device with local records in such a collection must merge into it, and
  // "Upload all local data" must end synced — and say so truthfully.
  for (const n of ['panels', 'breakers']) repo.set(`${DIR}/${n}.json`, { content: Buffer.from('null\n').toString('base64'), sha: shaOf(`legacy-${n}`) });
  await B.page.evaluate(async () => {
    const { store } = await import('/js/sync.js');
    await store.upsert('panels', { id: 'pB', name: 'Shed panel', spaces: 8 });
  });
  await B.page.click('[data-tab=settings]');
  await B.page.locator('summary', { hasText: 'Data repository' }).click();
  const uploadAllB = B.page.locator('details[data-section=datarepo]').getByRole('button', { name: 'Upload all local data' });

  // First with GitHub failing every write: the app must say so, not claim success.
  FAIL_PUTS = true;
  await uploadAllB.click();
  check(await until(() => logs.some((l) => l.includes('dev2') && l.includes('toast: Upload didn’t finish'))), 'Upload all reports failure when writes fail');
  check(!logs.some((l) => l.includes('dev2') && l.includes('toast: Uploaded all local data')), 'no false success toast');
  check(await until(() => B.page.locator('.sync-problem').isVisible()) && (await B.page.locator('.sync-problem').textContent()).includes('GitHub API 500'),
    'Settings shows the sync problem and its cause (no hover needed on a phone)');
  FAIL_PUTS = false;
  await B.page.locator('.sync-problem').getByRole('button', { name: 'Retry now' }).click();
  check(await until(async () => !(await B.page.locator('.sync-problem').isVisible())), '“Retry now” clears the problem once GitHub accepts writes');

  await uploadAllB.click();
  check(await until(() => logs.some((l) => l.includes('dev2') && l.includes('toast: Uploaded all local data'))), 'Upload all reports success when it succeeded');
  check(await until(async () => (await B.page.locator('#badge').textContent()) === 'synced'), 'second device ends synced, not stuck pending');
  const panelsNow = await B.page.evaluate(async () => {
    const { store } = await import('/js/sync.js');
    const f = await store.client.getFile('data/panels.json');
    return (await store.deserializeFile('data/panels.json', JSON.parse(f.content))).data.map((p) => p.name);
  });
  check(JSON.stringify(panelsNow) === '["Main panel","Shed panel"]', `local panel merged into the "null" file, nothing lost (${panelsNow})`);
  const nulls = [...repo.entries()].filter(([, f]) => decode(f.content).trim() === 'null').map(([k]) => k);
  check(nulls.length === 0, `no collection file left as "null" (${nulls.join(', ') || 'none'})`);

  step('Photo delete');
  const photosBefore = [...repo.keys()].filter((k) => k.startsWith(`${DIR}/photos/`)).length;
  await A.page.click('a[data-tab=paint]');
  await A.page.getByRole('tab', { name: 'Colors' }).click();
  await A.page.locator('.paint-card', { hasText: 'Agreeable Gray' }).click();
  await dialog(A.page).locator('.photo-x').first().click();
  await dialog(A.page).getByRole('button', { name: 'Save' }).click();
  await until(() => [...repo.keys()].filter((k) => k.startsWith(`${DIR}/photos/`)).length === photosBefore - 1);
  check([...repo.keys()].filter((k) => k.startsWith(`${DIR}/photos/`)).length === photosBefore - 1, 'removed photo deleted from repo');

  step('Public repo warning');
  PUBLIC = true;
  await A.page.click('[data-tab=settings]');
  await A.page.locator('summary', { hasText: 'Data repository' }).click();
  await A.page.locator('details[data-section=datarepo]').getByRole('button', { name: 'Save data repo' }).click();
  check(await until(() => logs.some((l) => l.includes('toast: Warning: that repo is PUBLIC'))), 'saving a public data repo warns');
  PUBLIC = false;

  step('Mobile layout');
  await A.page.setViewportSize({ width: 375, height: 800 });
  for (const tab of ['paint', 'breakers', 'inventory', 'maintenance', 'settings']) {
    await A.page.click(`[data-tab=${tab}]`);
    await A.page.waitForTimeout(100);
    const over = await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 0, `no horizontal page scroll on ${tab} at 375px`);
  }

  step('Hover help');
  {
    const p = A.page;
    await p.setViewportSize({ width: 1100, height: 900 });
    await p.click('[data-tab=breakers]');
    await p.getByRole('button', { name: '+ Breaker' }).click();
    const amps = fieldIn(p, 'Amps').locator('input');
    const tipEl = p.locator('#tooltip');
    const shown = () => tipEl.evaluate((t) => (t.popover ? t.matches(':popover-open') : !t.hidden)).catch(() => false);
    await p.mouse.move(0, 0);
    await amps.hover();
    await p.waitForTimeout(500);
    check(!(await shown()), 'no tooltip before ~1 s of hovering');
    check(await until(shown, 1500), 'tooltip appears after hovering a field');
    check((await tipEl.textContent()).includes('number on the handle'), 'tooltip explains that field (Amps)');
    const geo = await p.evaluate(() => {
      const t = document.getElementById('tooltip').getBoundingClientRect();
      const f = [...document.querySelectorAll('dialog[open] .field')].find((x) => x.querySelector('.field-label, label')?.textContent.trim() === 'Amps').getBoundingClientRect();
      const top = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
      return { clear: t.bottom <= f.top + 1 || t.top >= f.bottom - 1, onTop: top?.id === 'tooltip' || !!top?.closest?.('#tooltip') || getComputedStyle(document.getElementById('tooltip')).pointerEvents === 'none', inView: t.left >= 0 && t.right <= innerWidth && t.top >= 0 };
    });
    check(geo.clear && geo.inView, 'tooltip sits beside the field, inside the window');
    await amps.focus();
    await p.keyboard.type('3');
    check(!(await shown()), 'typing hides the tooltip');
    await p.keyboard.type('0');
    await p.waitForTimeout(1500);
    check(!(await shown()), 'it stays hidden while you keep typing in that field');
    await fieldIn(p, 'Label').locator('input').hover();
    check(await until(async () => (await shown()) && (await tipEl.textContent()).includes('panel door'), 2000), 'moving to another field shows that field’s help');
    await amps.hover();
    check(await until(async () => (await shown()) && (await tipEl.textContent()).includes('number on the handle'), 2000), 'coming back to the field shows its help again');
    await p.mouse.move(5, 5);
    check(await until(async () => !(await shown()), 1000), 'leaving the field hides it');
    await p.keyboard.press('Escape');
    const phone = await browser.newContext(devices['iPhone 13']);
    const pp = await phone.newPage();
    await pp.goto(BASE);
    check(await pp.locator('#tooltip').count() === 0, 'no hover tooltips on a touch phone');
    await phone.close();
  }

  step('iPhone: no zoom on focus');
  // iOS Safari zooms into any focused field under 16px. On a touch phone every
  // text field — including inside dialogs — must be at least 16px.
  {
    const phone = await browser.newContext(devices['iPhone 13']);
    const p = await phone.newPage();
    await p.goto(`${BASE}#inventory`);
    await p.getByRole('button', { name: '+ Add your first item' }).click();
    const small = await p.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=range]):not([type=color]):not([type=file]), select, textarea')]
      .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.getAttribute('aria-label') || e.type));
    check(small.length === 0, `all fields ≥ 16px on iPhone (too small: ${small.join(', ') || 'none'})`);
    await phone.close();
  }

  step('Console');
  check(A.errors.length === 0 && B.errors.length === 0, `no page errors ${[...A.errors, ...B.errors].join(' | ')}`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
