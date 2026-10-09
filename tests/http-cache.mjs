// Regression test for sync through the browser's HTTP cache.
// Run: node tests/http-cache.mjs   (needs `playwright`, `openssl`, and permission to bind port 443)
//
// tests/e2e.mjs stubs GitHub with page.route(), and routing turns Chromium's
// HTTP cache off — so it can't see a bug that only exists with the cache on.
// GitHub sends `Cache-Control: private, max-age=60` on API reads; without
// cache: 'no-store', a re-read right after a write (the 409 merge path) got
// the stale sha back and a second device's "Upload all local data" stayed
// pending forever. This test runs a fake api.github.com over real HTTPS with
// GitHub's caching headers, reached by host mapping instead of routing, so the
// browser cache is live:
//   1. a desktop seeds an empty repo;
//   2. legacy "null" collection files are planted (what older seeding wrote);
//   3. a phone with its own local records connects and presses Upload all.
// It must end synced, with both devices' records and no "null" files.

import { chromium } from 'playwright';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'home';

// ---------- throwaway TLS cert for api.github.com ----------
const tls = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-tls-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tls}/key.pem -out ${tls}/cert.pem -days 1 -subj /CN=api.github.com -addext subjectAltName=DNS:api.github.com`, { stdio: 'ignore' });
const spki = execSync(`openssl x509 -in ${tls}/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`).toString().trim();

// ---------- fake GitHub with real caching + CORS headers ----------
const repo = new Map(); // repo path -> { content (base64), sha }
const log = [];
const api = https.createServer({ key: await fs.readFile(`${tls}/key.pem`), cert: await fs.readFile(`${tls}/cert.pem`) }, async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, X-GitHub-Api-Version',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'https://api.github.com');
  log.push(`${req.method} ${decodeURIComponent(u.pathname).replace(/^.*\/contents\//, '')}`);
  const send = (status, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(status, {
      ...cors,
      'Content-Type': 'application/json',
      ...(req.method === 'GET' ? {
        'Cache-Control': 'private, max-age=60, s-maxage=60',
        ETag: `"${crypto.createHash('md5').update(s).digest('hex')}"`,
        Vary: 'Accept, Authorization, Cookie',
      } : {}),
    }).end(s);
  };
  const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/.exec(u.pathname);
  if (!m) return send(404, {});
  const p = m[3] === undefined ? undefined : decodeURIComponent(m[3]);
  if (p === undefined) return send(200, { private: true });
  const b = body ? JSON.parse(body) : null;
  if (req.method === 'GET') {
    if (repo.has(p)) { const f = repo.get(p); return send(200, { name: p.split('/').pop(), path: p, sha: f.sha, content: f.content, encoding: 'base64' }); }
    const kids = [...repo.entries()].filter(([k]) => k.startsWith(`${p}/`));
    return kids.length ? send(200, kids.map(([k, f]) => ({ name: k.split('/').pop(), path: k, sha: f.sha }))) : send(404, { message: 'Not Found' });
  }
  if (req.method === 'PUT') {
    const cur = repo.get(p);
    if (cur && b.sha !== cur.sha) return send(b.sha ? 409 : 422, { message: 'sha mismatch' });
    const sha = crypto.createHash('sha1').update(b.content + Math.random()).digest('hex');
    repo.set(p, { content: b.content, sha });
    return send(cur ? 200 : 201, { content: { sha } });
  }
  return send(405, {});
});
try {
  await new Promise((r, j) => { api.once('error', j); api.listen(443, '127.0.0.1', r); });
} catch (e) {
  console.log(`SKIP: cannot bind 127.0.0.1:443 (${e.code}) — run where that's allowed, e.g. as root in CI.`);
  process.exit(0);
}

// ---------- the app ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const web = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  try { res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => web.listen(0, r));
const BASE = `http://localhost:${web.address().port}/`;

// No proxy (it would bypass the host mapping); api.github.com -> 127.0.0.1:443;
// trust our cert by SPKI pin so responses are cacheable like the real thing.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  env,
  args: ['--no-proxy-server', '--host-resolver-rules=MAP api.github.com 127.0.0.1', `--ignore-certificate-errors-spki-list=${spki}`,
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks'],
});

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

// Create records through the app (so they're queued like real local edits),
// then connect the way Settings does: repo, token, flush, refresh.
async function device(seed) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE);
  await page.evaluate(async ({ seed: d, dir }) => {
    const { store } = await import('/js/sync.js');
    for (const [c, recs] of Object.entries(d)) for (const r of recs) await store.upsert(c, r);
    store.setDataRepo({ owner: 'me', repo: 'home-data', branch: 'main', dir });
    store.setToken('test-token');
    store.refreshStatus();
    await store.client.validate();
    await store.flushQueue();
    await store.refresh();
  }, { seed, dir: DIR });
  return page;
}
const state = (page) => page.evaluate(async () => {
  const { store } = await import('/js/sync.js');
  return { status: store.syncStatus().status, error: store.syncStatus().error?.message || '', queue: store.cache.getQueue() };
});
const uploadAll = (page) => page.evaluate(async () => (await import('/js/sync.js')).store.pushAllData());
const read = (name) => { const f = repo.get(`${DIR}/${name}.json`); return f ? JSON.parse(Buffer.from(f.content, 'base64').toString()) : undefined; };
const nullFiles = () => [...repo].filter(([, f]) => Buffer.from(f.content, 'base64').toString().trim() === 'null').map(([k]) => k);

try {
  console.log('Desktop seeds an empty repo');
  const desktop = await device({ rooms: [{ id: 'r1', name: 'Kitchen' }], items: [{ id: 'i1', name: 'TV' }] });
  await uploadAll(desktop);
  check((await state(desktop)).status === 'ok', 'desktop synced');
  check(nullFiles().length === 0, 'seeding writes no "null" files for collections the desktop never used');

  console.log('Phone connects (its own storage, own records) and presses Upload all within 60 s');
  for (const n of ['paints', 'panels', 'breakers', 'maintenance']) {
    repo.set(`${DIR}/${n}.json`, { content: Buffer.from('null\n').toString('base64'), sha: crypto.randomUUID().replace(/-/g, '') });
  }
  log.length = 0;
  const phone = await device({ items: [{ id: 'i2', name: 'Bike' }], paints: [{ id: 'p1', colorName: 'Hale Navy' }] });
  await uploadAll(phone);
  const s = await state(phone);
  check(s.status === 'ok' && s.queue.length === 0, `phone ends synced, not stuck pending (${s.status}${s.error ? `: ${s.error}` : ''}, queue ${s.queue.length})`);
  check(JSON.stringify(read('inventory')?.map((i) => i.name).sort()) === '["Bike","TV"]', 'both devices’ items are in the repo');
  check(JSON.stringify(read('paints')?.map((p) => p.colorName)) === '["Hale Navy"]', 'phone’s paint merged into a legacy "null" file');
  check(JSON.stringify(read('rooms')?.map((r) => r.name)) === '["Kitchen"]', 'desktop’s room kept (phone never had rooms)');
  check(nullFiles().every((k) => !k.endsWith('/rooms.json') && !k.endsWith('/inventory.json')), 'nothing the desktop wrote was overwritten with "null"');
  // Every 409/422 must be followed by a real read: PUT x, GET x, PUT x — never PUT x, PUT x.
  const writes = log.filter((l) => !l.startsWith('GET /repos'));
  const blind = writes.some((l, i) => l.startsWith('PUT') && writes[i + 1] === l);
  check(!blind, 'conflict retries re-read from the server, not the HTTP cache');
} finally {
  await browser.close();
  api.close();
  web.close();
  await fs.rm(tls, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
