// ghsync's own test suite: drives the real modules in Chromium against an
// in-memory fake of the GitHub Contents API. Run from anywhere:
//
//   node ghsync/tests/ghsync.test.mjs        (needs the `playwright` package)
//
// Set CHROMIUM_PATH to use a specific browser binary. Each test gets a fresh
// browser context (fresh localStorage) and builds its own store in the page
// with whatever collections it needs, so tests don't depend on any app.
//
// The fake can pause a request until the test releases it (gate) and fail the
// next matching request (failNext), which is how the race-condition tests
// recreate "an older push finishes after a newer edit" deterministically.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // the ghsync folder
const OWNER = 'me';
const REPO = 'data-repo';

// ---------- static server for the ghsync folder ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'example/index.html' : p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

// ---------- fake GitHub ----------
let repo; // path -> { content (base64), sha }
let calls; // { method, path, body }
let gates; // pause a matching request until released
let failures; // fail the next matching request
let isPublic;

function resetFake() {
  repo = new Map(); calls = []; gates = []; failures = []; isPublic = false;
}
const sha1 = (s) => crypto.createHash('sha1').update(s + Math.random()).digest('hex');
const enc = (s) => Buffer.from(s).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
const setRemote = (p, text) => { repo.set(p, { content: enc(text), sha: sha1(text) }); };
const remoteJson = (p) => (repo.has(p) ? JSON.parse(dec(repo.get(p).content)) : undefined);
const puts = (p) => calls.filter((c) => c.method === 'PUT' && (!p || c.path === p)).length;

// Pause the next `method` request whose repo path matches `re`.
function gate(method, re) {
  const g = { method, re };
  g.arrived = new Promise((r) => { g.onArrive = r; });
  g.released = new Promise((r) => { g.release = r; });
  gates.push(g);
  return g;
}
// status 0 = no response at all (the connection drops).
const failNext = (method, re, status, body = {}, headers = {}) => failures.push({ method, re, status, body, headers });

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/.exec(url.pathname);
  const p = m && m[3] !== undefined ? decodeURIComponent(m[3]) : undefined;
  calls.push({ method, path: p, body });
  const json = (status, obj, headers = {}) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(obj),
    headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-RateLimit-Remaining, Retry-After', ...headers },
  });
  const gi = gates.findIndex((g) => g.method === method && p !== undefined && g.re.test(p));
  if (gi >= 0) {
    const [g] = gates.splice(gi, 1);
    g.onArrive();
    await g.released; // the server "processes" the request now, against the repo as it is now
  }
  const fi = failures.findIndex((f) => f.method === method && p !== undefined && f.re.test(p));
  if (fi >= 0) {
    const [f] = failures.splice(fi, 1);
    if (f.status === 0) return route.abort('internetdisconnected');
    return json(f.status, f.body, f.headers);
  }
  if (req.headers().authorization !== 'Bearer tok') return json(401, { message: 'Bad credentials' });
  if (!m || m[1] !== OWNER || m[2] !== REPO) return json(404, { message: 'Not Found' });
  if (p === undefined) return json(200, { private: !isPublic });
  if (method === 'GET') {
    if (repo.has(p)) {
      const f = repo.get(p);
      return json(200, { name: p.split('/').pop(), path: p, sha: f.sha, content: f.content, encoding: 'base64' });
    }
    const kids = [...repo.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'));
    if (kids.length) return json(200, kids.map(([k, f]) => ({ name: k.split('/').pop(), path: k, sha: f.sha })));
    return json(404, { message: 'Not Found' });
  }
  if (method === 'PUT') {
    const cur = repo.get(p);
    if (cur && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    if (cur && body.sha !== cur.sha) return json(409, { message: `${p} does not match ${body.sha}` });
    if (!cur && body.sha) return json(422, { message: 'Invalid request.\n\n"sha" was supplied but the file does not exist.' });
    const sha = sha1(body.content);
    repo.set(p, { content: body.content, sha });
    return json(cur ? 200 : 201, { content: { sha, path: p } });
  }
  if (method === 'DELETE') {
    const cur = repo.get(p);
    if (!cur) return json(404, { message: 'Not Found' });
    if (body?.sha !== cur.sha) return json(409, { message: `${p} does not match ${body?.sha}` });
    repo.delete(p);
    return json(200, { content: null });
  }
  return json(405, {});
}

// ---------- harness ----------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failed = 0;
let passed = 0;
const results = [];

async function newPage() {
  const ctx = await browser.newContext();
  await ctx.route('https://api.github.com/**', github);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}example/index.html`);
  // window.mk(appId, files, opts) -> creates window.S, connected to the fake repo.
  await page.evaluate(() => {
    window.mk = async (appId, files, opts = {}) => {
      const { createStore } = await import('/store.js');
      const s = createStore({ appId, files, retryMs: 0, encrypted: Object.keys(files), ...opts });
      s.setDataRepo({ owner: 'me', repo: 'data-repo' });
      s.setToken('tok');
      window.S = s;
      return true;
    };
  });
  return { ctx, page, errors };
}

async function test(name, fn) {
  resetFake();
  const t = await newPage();
  try {
    await fn(t);
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ✗ ${name}\n      ${String(e.message || e).split('\n').join('\n      ')}`);
  } finally {
    await t.ctx.close();
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (p) => (remoteJson(p) || []).map((r) => r.id).sort().join(',');

// ---------- the basics ----------

await test('nothing is sent to GitHub without a data repo and a token', async ({ page }) => {
  await page.evaluate(async () => {
    const { createStore } = await import('/store.js');
    const s = createStore({ appId: 'local', files: { notes: 'data/notes.json' }, retryMs: 0 });
    s.init();
    await s.upsert('notes', { id: 'a', text: 'hi' });
    window.S = s;
  });
  await wait(200);
  expect(calls.length === 0, `expected no requests, saw ${calls.length}`);
  expect((await page.evaluate(() => window.S.syncStatus().status)) === 'local', 'status should be local');
});

await test('writes create the file, then update it with the right sha', async ({ page }) => {
  await page.evaluate(() => window.mk('basic', { notes: 'data/notes.json' }));
  await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); await S.upsert('notes', { id: 'b' }); });
  expect(ids('data/notes.json') === 'a,b', `remote has ${ids('data/notes.json')}`);
  expect(puts() === 2, `expected 2 PUTs, saw ${puts()}`);
  expect((await page.evaluate(() => S.syncStatus().status)) === 'ok', 'status should be ok');
});

await test('a 409 merges both devices’ records by id', async ({ page }) => {
  await page.evaluate(() => window.mk('merge', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.upsert('notes', { id: 'a' }));
  setRemote('data/notes.json', JSON.stringify([{ id: 'a' }, { id: 'other-device' }]));
  await page.evaluate(() => S.upsert('notes', { id: 'b' }));
  expect(ids('data/notes.json') === 'a,b,other-device', `remote has ${ids('data/notes.json')}`);
});

// ---------- 1.3: only the records this device edited win a merge ----------

await test('a conflict does not revert a record another device changed', async ({ page }) => {
  await page.evaluate(() => window.mk('stale', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a', v: 1 }, { id: 'b', v: 1 }]));
  // Another device edits a; this one, still holding a v1, edits b.
  setRemote('data/notes.json', JSON.stringify([{ id: 'a', v: 2 }, { id: 'b', v: 1 }]));
  await page.evaluate(() => S.upsert('notes', { id: 'b', v: 3 }));
  const remote = Object.fromEntries(remoteJson('data/notes.json').map((r) => [r.id, r.v]));
  expect(remote.a === 2, `the other device's edit to a was reverted to v${remote.a}`);
  expect(remote.b === 3, `this device's edit to b was lost (v${remote.b})`);
  const local = await page.evaluate(() => Object.fromEntries(S.get('notes').map((r) => [r.id, r.v])));
  expect(local.a === 2 && local.b === 3, `local copy is ${JSON.stringify(local)}`);
});

await test('a record deleted on another device stays deleted after a conflict', async ({ page }) => {
  await page.evaluate(() => window.mk('gone', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a' }, { id: 'b' }]));
  setRemote('data/notes.json', JSON.stringify([{ id: 'b' }]));
  await page.evaluate(() => S.upsert('notes', { id: 'c' }));
  expect(ids('data/notes.json') === 'b,c', `remote has ${ids('data/notes.json')} (a came back)`);
});

await test('a record deleted here stays deleted after a conflict', async ({ page }) => {
  await page.evaluate(() => window.mk('mine', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a' }, { id: 'b' }]));
  setRemote('data/notes.json', JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'x' }]));
  await page.evaluate(() => S.remove('notes', 'a'));
  expect(ids('data/notes.json') === 'b,x', `remote has ${ids('data/notes.json')}`);
});

await test('a queued path with no edit list (older version) still merges as a union', async ({ page }) => {
  await page.evaluate(() => window.mk('legacy', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a' }]));
  setRemote('data/notes.json', JSON.stringify([{ id: 'other' }]));
  await page.evaluate(() => {
    S.cache.setData('data/notes.json', [{ id: 'a' }, { id: 'b' }]);
    S.cache.markDirty('data/notes.json'); // as 1.2 queued it: no list of edited ids
    return S.flushQueue();
  });
  expect(ids('data/notes.json') === 'a,b,other', `remote has ${ids('data/notes.json')}`);
});

await test('a legacy "null" file in the repo drops nothing local', async ({ page }) => {
  await page.evaluate(() => window.mk('nullfile', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a' }, { id: 'b' }]));
  setRemote('data/notes.json', 'null\n');
  await page.evaluate(() => S.upsert('notes', { id: 'c' }));
  expect(ids('data/notes.json') === 'a,b,c', `remote has ${ids('data/notes.json')}`);
});

await test('a merge that took in another device\'s changes says so', async ({ page }) => {
  await page.evaluate(() => window.mk('mergedev', { notes: 'data/notes.json' }));
  await page.evaluate(() => { window.ev = []; S.onChange((e) => window.ev.push(e.type)); return S.save('notes', [{ id: 'a' }]); });
  const quiet = await page.evaluate(() => window.ev.filter((t) => t === 'merged').length);
  setRemote('data/notes.json', JSON.stringify([{ id: 'a' }, { id: 'theirs' }]));
  await page.evaluate(() => S.upsert('notes', { id: 'b' }));
  const after = await page.evaluate(() => window.ev.filter((t) => t === 'merged').length);
  expect(quiet === 0 && after === 1, `merged events: ${quiet} before the conflict, ${after} after`);
});

await test('edits made before the repo file exists all upload', async ({ page }) => {
  await page.evaluate(() => window.mk('fresh', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.save('notes', [{ id: 'a' }, { id: 'b' }]));
  repo.delete('data/notes.json'); // the file vanished (repo switched, folder moved)
  await page.evaluate(() => S.upsert('notes', { id: 'c' }));
  expect(ids('data/notes.json') === 'a,b,c', `remote has ${ids('data/notes.json')}`);
});

await test('offline edits queue and flush when back online', async ({ ctx, page }) => {
  await page.evaluate(() => { window.mk('offline', { notes: 'data/notes.json' }); });
  await page.evaluate(() => S.init());
  await ctx.setOffline(true);
  await page.evaluate(() => S.upsert('notes', { id: 'a' }));
  expect(puts() === 0, 'nothing should be sent offline');
  expect((await page.evaluate(() => S.syncStatus().status)) === 'pending', 'status should be pending');
  await ctx.setOffline(false);
  for (let i = 0; i < 40 && ids('data/notes.json') !== 'a'; i++) await wait(100);
  expect(ids('data/notes.json') === 'a', 'queued edit should be pushed on reconnect');
});

await test('encrypted files carry no plaintext, and decrypt on another device', async ({ page }) => {
  await page.evaluate(() => window.mk('enc', { notes: 'data/notes.json' }));
  await page.evaluate(async () => { S.setPassword('hunter2'); await S.upsert('notes', { id: 'a', text: 'secret diary' }); });
  const raw = dec(repo.get('data/notes.json').content);
  expect(raw.includes('ft-encrypted') && !raw.includes('secret diary'), 'file must be an envelope without plaintext');
  const got = await page.evaluate(async () => {
    const { createStore } = await import('/store.js');
    const b = createStore({ appId: 'enc-b', files: { notes: 'data/notes.json' }, encrypted: ['notes'], retryMs: 0 });
    b.setDataRepo({ owner: 'me', repo: 'data-repo' }); b.setToken('tok'); b.setPassword('hunter2');
    await b.refresh();
    return b.get('notes')[0]?.text;
  });
  expect(got === 'secret diary', `second device read ${got}`);
});

await test('files over ~100 KB encode and decode (chunked base64)', async ({ page }) => {
  await page.evaluate(() => window.mk('big', { notes: 'data/notes.json' }));
  const n = await page.evaluate(async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, text: 'x'.repeat(80) + 'é' }));
    await S.save('notes', big);
    S.cache.setSha('data/notes.json', null);
    S.cache.setData('data/notes.json', null);
    await S.refresh();
    return S.get('notes').length;
  });
  expect(dec(repo.get('data/notes.json').content).length > 200_000, 'file should be large');
  expect(n === 3000, `read back ${n} records`);
});

await test('a collection never loaded on this device is never written (no "null" files)', async ({ page }) => {
  await page.evaluate(() => window.mk('nulls', { notes: 'data/notes.json', other: 'data/other.json' }));
  await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); await S.pushAllData(); });
  expect(!repo.has('data/other.json'), 'other.json should not be created');
});

await test('merging into a legacy "null" file works', async ({ page }) => {
  setRemote('data/notes.json', 'null\n');
  await page.evaluate(() => window.mk('legacy', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.upsert('notes', { id: 'a' }));
  expect(ids('data/notes.json') === 'a', `remote has ${ids('data/notes.json')}`);
});

await test('a chosen folder maps every path, nothing is written outside it', async ({ page }) => {
  await page.evaluate(() => window.mk('dir', { notes: 'data/notes.json' }));
  await page.evaluate(async () => { S.setDataRepo({ owner: 'me', repo: 'data-repo', dir: 'apps/my notes' }); await S.upsert('notes', { id: 'a' }); });
  expect(repo.has('apps/my notes/notes.json') && repo.size === 1, `repo has ${[...repo.keys()]}`);
});

await test('attachments (blobs.js): encrypted upload, mirrored to a second device, deleted', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { createStore } = await import('/store.js');
    const { createBlobStore, processDocument } = await import('/blobs.js');
    // The wiring from README "Photos and files".
    function device(appId) {
      let blobs;
      const store = createStore({
        appId, files: { notes: 'data/notes.json' }, encrypted: ['notes'], retryMs: 0,
        encryptPath: (p) => blobs.owns(p),
        onRefresh: () => blobs.mirror(),
      });
      blobs = createBlobStore(store, { dbName: `${appId}.files`, dir: 'data/files', kind: 'files' });
      store.setDataRepo({ owner: 'me', repo: 'data-repo' }); store.setToken('tok'); store.setPassword('pw');
      return { store, blobs };
    }
    const a = device('blob-a');
    const id = await a.blobs.add(await processDocument(new File(['the manual text'], 'manual.txt', { type: 'text/plain' })));
    await a.blobs.flush();
    const b = device('blob-b');
    await b.store.refresh();
    const got = await (await b.blobs.blob(id))?.text();
    await a.blobs.remove(id);
    await a.blobs.flush();
    return { id, got };
  });
  const p = `data/files/${out.id}.json`;
  expect(out.got === 'the manual text', `second device read ${out.got}`);
  expect(calls.some((c) => c.method === 'PUT' && c.path === p && !dec(c.body.content).includes(enc('the manual text'))
    && dec(c.body.content).includes('ft-encrypted')), 'the uploaded file must be encrypted');
  expect(!repo.has(p), 'remove() should delete the repo file');
});

// ---------- regressions: bugs found in review ----------

await test('an older push finishing last does not drop a newer queued edit', async ({ page }) => {
  await page.evaluate(() => window.mk('race1', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.upsert('notes', { id: 'a' }));
  const g = gate('PUT', /notes\.json$/);
  await page.evaluate(() => { window.p1 = S.upsert('notes', { id: 'b' }); });
  await g.arrived;
  failNext('PUT', /notes\.json$/, 500, { message: 'Server Error' }); // the newer edit's push fails…
  await page.evaluate(() => { window.p2 = S.upsert('notes', { id: 'c' }); });
  await wait(300);
  g.release(); // …and the older push succeeds afterwards
  await page.evaluate(() => Promise.all([window.p1, window.p2]));
  await page.evaluate(() => S.flushQueue());
  expect(ids('data/notes.json') === 'a,b,c', `remote has ${ids('data/notes.json')} — the edit "c" was lost`);
});

await test('a refresh landing during an edit does not overwrite it', async ({ page }) => {
  await page.evaluate(() => window.mk('race2', { notes: 'data/notes.json' }));
  await page.evaluate(() => S.upsert('notes', { id: 'a' }));
  setRemote('data/notes.json', JSON.stringify([{ id: 'a' }, { id: 'x-other-device' }]));
  const gGet = gate('GET', /notes\.json$/);
  await page.evaluate(() => { window.r = S.refresh(); });
  await gGet.arrived; // refresh is downloading…
  const gPut = gate('PUT', /notes\.json$/);
  await page.evaluate(() => { window.p = S.upsert('notes', { id: 'L-local-edit' }); });
  await gPut.arrived; // …the user edits; the push is on its way…
  gGet.release(); // …the download lands…
  await wait(200);
  gPut.release(); // …and the push hits a 409 and merges
  await page.evaluate(() => Promise.all([window.r, window.p]));
  const local = await page.evaluate(() => S.get('notes').map((n) => n.id).sort().join(','));
  expect(ids('data/notes.json') === 'L-local-edit,a,x-other-device', `remote has ${ids('data/notes.json')}`);
  expect(local === 'L-local-edit,a,x-other-device', `local has ${local}`);
});

await test('one corrupt file does not stop the rest of a refresh', async ({ page }) => {
  setRemote('data/a.json', '{ this is not json');
  setRemote('data/b.json', JSON.stringify([{ id: 'b1' }]));
  await page.evaluate(() => window.mk('corrupt', { a: 'data/a.json', b: 'data/b.json' }));
  const out = await page.evaluate(async () => { await S.refresh(); return { b: S.get('b').length, st: S.syncStatus() }; });
  expect(out.b === 1, 'b.json should still load');
  expect(out.st.status === 'error' && /a\.json/.test(out.st.error?.message || ''), `status should name the bad file, got ${out.st.status}: ${out.st.error?.message}`);
});

await test('a rate limit is temporary, not an auth failure', async ({ page }) => {
  await page.evaluate(() => window.mk('ratelimit', { notes: 'data/notes.json' }));
  failNext('PUT', /notes\.json$/, 403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
  const st = await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); return S.syncStatus(); });
  expect(st.status === 'pending', `status should stay pending (retry later), got ${st.status}`);
  expect(/rate limit/i.test(st.error?.message || ''), `error should say rate limit, got ${st.error?.message}`);
  await page.evaluate(() => S.flushQueue());
  expect(ids('data/notes.json') === 'a', 'the retry should succeed');
});

await test('a 422 that isn’t about the sha is reported, not retried as a conflict', async ({ page }) => {
  await page.evaluate(() => window.mk('unprocessable', { notes: 'data/notes.json' }));
  failNext('PUT', /notes\.json$/, 422, { message: 'path contains a malformed path component' });
  const st = await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); return S.syncStatus(); });
  expect(puts() === 1, `expected one PUT, saw ${puts()} (treated as a conflict)`);
  expect(/malformed path/.test(st.error?.message || ''), `error should carry GitHub's message, got ${st.error?.message}`);
});

await test('overlapping flushes push a file once', async ({ page }) => {
  await page.evaluate(async () => {
    await window.mk('overlap', { notes: 'data/notes.json' });
    S.setToken(''); // queue an edit without pushing
    await S.upsert('notes', { id: 'a' });
    S.setToken('tok');
    await Promise.all([S.flushQueue(), S.flushQueue(), S.flushQueue()]);
  });
  expect(puts() === 1, `expected 1 PUT, saw ${puts()}`);
  expect(ids('data/notes.json') === 'a', `remote has ${ids('data/notes.json')}`);
});

await test('a failed unlock keeps the previous password', async ({ page }) => {
  await page.evaluate(async () => {
    await window.mk('writer', { notes: 'data/notes.json' });
    S.setPassword('right');
    await S.upsert('notes', { id: 'a', text: 'secret' });
  });
  // The example app's own store (appId "notes"), connected but without the password.
  await page.evaluate(() => {
    localStorage.setItem('notes.datarepo', JSON.stringify({ owner: 'me', repo: 'data-repo' }));
    localStorage.setItem('notes.pat', 'tok');
  });
  await page.reload();
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.locator('summary', { hasText: 'Privacy' }).click();
  await page.locator('input[type=password]').last().fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await wait(1500);
  const pw = await page.evaluate(() => localStorage.getItem('notes.enc.pw'));
  expect(pw === null, `the wrong password should not be kept (stored: ${pw})`);
});

await test('a full browser storage is reported, not silently lost', async ({ page }) => {
  await page.evaluate(() => window.mk('quota', { notes: 'data/notes.json' }));
  const out = await page.evaluate(async () => {
    const chunk = 'x'.repeat(256 * 1024);
    let i = 0;
    try { for (;;) localStorage.setItem(`filler${i++}`, chunk); } catch { /* full */ }
    let err = null;
    try { await S.upsert('notes', { id: 'a', text: 'y'.repeat(300 * 1024) }); } catch (e) { err = e; }
    for (let j = 0; j < i; j++) localStorage.removeItem(`filler${j}`);
    return { thrown: err?.name || null, st: S.syncStatus() };
  });
  expect(out.st.status === 'error' && /storage is full/i.test(out.st.error?.message || ''), `status should say storage is full, got ${out.st.status}: ${out.st.error?.message}`);
  expect(out.thrown === 'StorageFullError', `upsert should reject with StorageFullError, got ${out.thrown}`);
});

// ---------- 1.2: what counts as "error", and files that aren't lists ----------

await test('a push that gives up after repeated conflicts is an error, not pending', async ({ page }) => {
  await page.evaluate(() => window.mk('giveup', { notes: 'data/notes.json' }));
  for (let i = 0; i < 3; i++) failNext('PUT', /notes\.json$/, 409, { message: 'data/notes.json does not match' });
  const st = await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); return S.syncStatus(); });
  expect(st.status === 'error', `status should be error, got ${st.status}`);
  expect(/Gave up/.test(st.error?.message || ''), `error should say it gave up, got ${st.error?.message}`);
  expect(await page.evaluate(() => S.cache.isDirty('data/notes.json')), 'the edit should stay queued');
});

await test('a GitHub 5xx and a dropped connection stay pending', async ({ page }) => {
  await page.evaluate(() => window.mk('transient', { notes: 'data/notes.json' }));
  failNext('PUT', /notes\.json$/, 503, { message: 'Service Unavailable' });
  const a = await page.evaluate(async () => { await S.upsert('notes', { id: 'a' }); return S.syncStatus(); });
  expect(a.status === 'pending' && a.error?.name === 'ServerError', `5xx: got ${a.status} / ${a.error?.name}`);
  failNext('PUT', /notes\.json$/, 0);
  const b = await page.evaluate(async () => { await S.upsert('notes', { id: 'b' }); return S.syncStatus(); });
  expect(b.status === 'pending' && b.error?.name === 'NetworkError', `network: got ${b.status} / ${b.error?.name}`);
  await page.evaluate(() => S.flushQueue());
  expect(ids('data/notes.json') === 'a,b', `the retry should go through, remote has ${ids('data/notes.json')}`);
});

await test('a collection file that isn’t a list is never overwritten by a merge', async ({ page }) => {
  // e.g. another app's file, after two apps were pointed at the same folder
  const foreign = { notes: [{ id: 'x', text: 'someone else’s data' }], version: 3 };
  setRemote('data/notes.json', JSON.stringify(foreign));
  await page.evaluate(() => window.mk('notalist', { notes: 'data/notes.json' }));
  const st = await page.evaluate(async () => { await S.upsert('notes', { id: 'mine' }); return S.syncStatus(); });
  expect(JSON.stringify(remoteJson('data/notes.json')) === JSON.stringify(foreign), `the remote file was changed: ${dec(repo.get('data/notes.json').content)}`);
  expect(st.status === 'error' && st.error?.name === 'ShapeError', `got ${st.status} / ${st.error?.name}`);
  expect(/data\/notes\.json/.test(st.error.message) && /an object/.test(st.error.message), `message should name the file and what it found: ${st.error.message}`);
  const local = await page.evaluate(() => ({ ids: S.get('notes').map((n) => n.id), dirty: S.cache.isDirty('data/notes.json') }));
  expect(local.ids.join() === 'mine' && local.dirty, `the local edit should be kept and queued: ${JSON.stringify(local)}`);
  // Once the file is sorted out in the repo, the queued edit goes through.
  repo.delete('data/notes.json');
  await page.evaluate(() => S.flushQueue());
  expect(ids('data/notes.json') === 'mine', `after the fix the edit should upload, remote has ${ids('data/notes.json')}`);
});

await test('records without an id are never merged away', async ({ page }) => {
  const remote = [{ text: 'hand-written 1' }, { text: 'hand-written 2' }];
  setRemote('data/notes.json', JSON.stringify(remote));
  await page.evaluate(() => window.mk('noids', { notes: 'data/notes.json' }));
  const st = await page.evaluate(async () => { await S.upsert('notes', { id: 'mine' }); return S.syncStatus(); });
  expect(JSON.stringify(remoteJson('data/notes.json')) === JSON.stringify(remote), 'both id-less records must survive');
  expect(st.status === 'error' && /without an id/.test(st.error?.message || ''), `got ${st.status}: ${st.error?.message}`);
});

await test('refresh never loads a file that isn’t a list, and still loads the others', async ({ page }) => {
  setRemote('data/a.json', JSON.stringify({ not: 'a list' }));
  setRemote('data/b.json', JSON.stringify([{ id: 'b1' }]));
  await page.evaluate(() => window.mk('shape-refresh', { a: 'data/a.json', b: 'data/b.json' }));
  const out = await page.evaluate(async () => {
    await S.refresh();
    return { a: S.get('a'), b: S.get('b').length, st: S.syncStatus() };
  });
  expect(Array.isArray(out.a) && out.a.length === 0, `a should stay an empty list locally, got ${JSON.stringify(out.a)}`);
  expect(out.b === 1, 'b.json should still load');
  expect(out.st.status === 'error' && /a\.json/.test(out.st.error?.message || ''), `status should name a.json, got ${out.st.status}: ${out.st.error?.message}`);
});

await test('the error report explains the failure and never contains the token or password', async ({ page }) => {
  const out = await page.evaluate(async () => {
    await window.mk('report', { notes: 'data/notes.json' });
    S.setToken('ghp_DO_NOT_LEAK_123');      // the fake answers 401 to anything but "tok"
    S.setPassword('hunter2-DO_NOT_LEAK');
    await S.upsert('notes', { id: 'a' });
    const { errorReport } = await import('/settings-ui.js');
    return { report: errorReport(S), st: S.syncStatus() };
  });
  expect(out.st.status === 'error' && out.st.error?.name === 'AuthError', `expected an auth error, got ${out.st.status}`);
  for (const want of [/AuthError/, /401/, /me\/data-repo\/data/, /data\/notes\.json/, /ghsync 1\.4/]) {
    expect(want.test(out.report), `report should match ${want}:\n${out.report}`);
  }
  expect(!/DO_NOT_LEAK/.test(out.report), `report leaked a secret:\n${out.report}`);
});

await test('a refresh that GitHub rejects is reported; a dropped connection is not', async ({ page }) => {
  setRemote('data/notes.json', JSON.stringify([{ id: 'a' }]));
  await page.evaluate(() => window.mk('refresh-errors', { notes: 'data/notes.json' }));
  failNext('GET', /notes\.json$/, 0);
  const blip = await page.evaluate(async () => { S.refreshStatus(); await S.refresh(); return S.syncStatus(); });
  expect(blip.status === 'ok' && !blip.error, `a network blip should change nothing, got ${blip.status}: ${blip.error?.message}`);
  failNext('GET', /notes\.json$/, 400, { message: 'Bad request' });
  const bad = await page.evaluate(async () => { await S.refresh(); return S.syncStatus(); });
  expect(bad.status === 'error' && bad.error?.name === 'RequestError', `got ${bad.status}: ${bad.error?.name}`);
});

await test('the example app: clicking "sync error" opens the copyable report', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('notes.datarepo', JSON.stringify({ owner: 'me', repo: 'data-repo' }));
    localStorage.setItem('notes.pat', 'expired-token'); // the fake answers 401
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('badge').textContent === 'sync error');
  await page.getByRole('button', { name: 'sync error' }).click();
  const text = await page.locator('dialog[open] textarea').inputValue();
  expect(/AuthError: GitHub auth failed \(401\)/.test(text), `report should explain the 401:\n${text}`);
  expect(!text.includes('expired-token'), 'the report must not contain the token');
  await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
  expect((await page.locator('dialog').count()) === 0, 'Close should remove the dialog');
});

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nAll ${passed} tests passed`);
process.exit(failed ? 1 : 0);
