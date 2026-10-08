// Photos live outside the ghsync collection model: one file per photo at
// data/photos/<id>.json in the data repo, and an IndexedDB mirror locally.
//
// Why not a collection field: localStorage tops out around 5 MB and the
// Contents API only returns files under 1 MB, so base64 images inside
// inventory.json would break both within a few dozen photos. Instead each
// photo is downscaled to a JPEG (< ~400 KB) plus a small thumbnail and
// stored by id; records only hold photo ids.
//
// The browser is the only writer of data/photos/ (ghsync invariant 1). Photo
// files go through store.serializeFile/deserializeFile, so they are encrypted
// exactly when the collections are (sync.js claims the path in encryptPath).

import { NotFoundError, ConflictError, AuthError } from '../ghsync/store.js';

const DIR = 'data/photos';
const MAX_EDGE = 1600;
const THUMB_EDGE = 240;
const MAX_B64 = 520_000; // ~390 KB JPEG; leaves headroom under the 1 MB API limit after encryption

// ---------- IndexedDB ----------
// Records: { id, mime, data, thumb, sha, state: 'synced' | 'pending' | 'deleted' }

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(dbp, mode, fn) {
  return dbp.then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('photos', mode);
    const req = fn(t.objectStore('photos'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}

// ---------- image processing ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name || 'image'}`)); };
    img.src = url;
  });
}

function toJpeg(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality).split(',')[1];
}

// File -> { mime, data, thumb } (base64, no data: prefix), sized for the repo.
export async function processImage(file) {
  const img = await loadImage(file);
  let edge = MAX_EDGE;
  let q = 0.82;
  let data = toJpeg(img, edge, q);
  while (data.length > MAX_B64 && (q > 0.5 || edge > 800)) {
    if (q > 0.5) q -= 0.1;
    else edge = Math.round(edge * 0.8);
    data = toJpeg(img, edge, q);
  }
  return { mime: 'image/jpeg', data, thumb: toJpeg(img, THUMB_EDGE, 0.7) };
}

// ---------- the photo store ----------

export function createPhotos(store, appId) {
  const dbp = openDb(`${appId}.photos`);
  const get = (id) => tx(dbp, 'readonly', (s) => s.get(id));
  const put = (rec) => tx(dbp, 'readwrite', (s) => s.put(rec));
  const del = (id) => tx(dbp, 'readwrite', (s) => s.delete(id));
  const all = () => tx(dbp, 'readonly', (s) => s.getAll());
  const pathOf = (id) => `${DIR}/${id}.json`;
  const inflight = new Map();
  const thumbs = new Map(); // id -> thumb data: URL, so re-renders paint without an IDB round trip
  let flushing = null;
  let pendingCount = 0;

  const changed = () => store.emit({ type: 'changed', collection: 'photos' });

  async function recount() {
    const n = (await all()).filter((r) => r.state !== 'synced').length;
    if (n !== pendingCount) {
      pendingCount = n;
      store.emit({ type: 'sync-status', ...store.syncStatus() });
    }
  }

  // New photo from a processed image. Returns its id immediately; the upload
  // happens in the background (or waits in the queue while offline/local-only).
  async function add(processed) {
    const id = crypto.randomUUID();
    await put({ id, ...processed, sha: null, state: 'pending' });
    flush();
    return id;
  }

  async function remove(id) {
    const rec = await get(id);
    if (!rec) return;
    thumbs.delete(id);
    if (rec.state === 'pending' && !rec.sha) await del(id); // never uploaded
    else await put({ id, sha: rec.sha, state: 'deleted' });
    flush();
  }

  // -> { full, thumb } data: URLs, or null if unavailable. Fetches lazily from
  // the repo when this device doesn't have it yet.
  async function urls(id) {
    let rec = await get(id);
    if (!rec?.data && store.canSync() && navigator.onLine) {
      if (!inflight.has(id)) inflight.set(id, download(id).finally(() => inflight.delete(id)));
      try {
        rec = await inflight.get(id);
      } catch (e) {
        console.warn('photo fetch failed', id, e);
        rec = null;
      }
    }
    if (!rec?.data) return null;
    const thumb = `data:${rec.mime};base64,${rec.thumb || rec.data}`;
    thumbs.set(id, thumb);
    return { full: `data:${rec.mime};base64,${rec.data}`, thumb };
  }

  const cachedThumb = (id) => thumbs.get(id) || null;

  async function download(id, knownSha) {
    const path = pathOf(id);
    const { content, sha } = await store.client.getFile(path);
    if (knownSha && sha !== knownSha) { /* fine — take what is there */ }
    const res = await store.deserializeFile(path, JSON.parse(content));
    if (res.locked) return null;
    const rec = { id, mime: res.data.mime, data: res.data.data, thumb: res.data.thumb, sha, state: 'synced' };
    await put(rec);
    return rec;
  }

  async function pushOne(rec) {
    const path = pathOf(rec.id);
    if (rec.state === 'deleted') {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let sha = rec.sha;
          if (!sha) sha = (await store.client.getFile(path)).sha;
          await store.client.deleteFile(path, sha, `Delete ${path}`);
          break;
        } catch (e) {
          if (e instanceof NotFoundError) break; // already gone
          if (!(e instanceof ConflictError) || attempt) throw e;
          rec.sha = null; // stale sha: look it up again
        }
      }
      await del(rec.id);
      return;
    }
    const content = await store.serializeFile(path, { mime: rec.mime, data: rec.data, thumb: rec.thumb });
    let sha;
    try {
      sha = await store.client.putFile(path, content, rec.sha, `Add ${path}`);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // Photos are immutable per id, so a conflict only means our sha is
      // stale (e.g. a re-encrypt from another device). Overwrite with ours.
      let remoteSha = null;
      try { remoteSha = (await store.client.getFile(path)).sha; } catch (e2) { if (!(e2 instanceof NotFoundError)) throw e2; }
      sha = await store.client.putFile(path, content, remoteSha, `Add ${path}`);
    }
    await put({ ...rec, sha, state: 'synced' });
  }

  // Push every queued upload/delete. Serialised so overlapping triggers
  // (online event, timer, a save) don't double-PUT. The reset happens in a
  // chained .finally so it can't run before `flushing` is assigned.
  function flush() {
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  async function doFlush() {
    try {
      if (!store.canSync() || !navigator.onLine) return;
      for (const rec of await all()) {
        if (rec.state === 'synced') continue;
        try {
          await pushOne(rec);
        } catch (e) {
          if (e instanceof AuthError) break;
          console.warn('photo push failed', rec.id, e);
        }
      }
    } finally {
      await recount();
    }
  }

  // Called from store.refresh(): push our queue, then pull any photos another
  // device added. Never deletes local copies for files missing remotely — a
  // freshly connected empty repo would otherwise wipe this device's photos
  // before "Upload all local data" seeds it.
  async function mirror() {
    if (!store.canSync() || !navigator.onLine) return false;
    await flush();
    const local = new Map((await all()).map((r) => [r.id, r]));
    let any = false;
    for (const entry of await store.client.listDir(DIR)) {
      const m = /^(.+)\.json$/.exec(entry.name);
      if (!m) continue;
      const rec = local.get(m[1]);
      if (rec && (rec.state !== 'synced' || rec.sha === entry.sha)) continue;
      try {
        if (await download(m[1], entry.sha)) any = true;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        console.warn('photo download failed', entry.path, e);
      }
    }
    if (any) changed();
    return any;
  }

  // Re-upload every local photo: after a password change (re-encrypt), or with
  // reseed=true when seeding a newly connected repo (forget old shas first).
  async function pushAll(reseed = false) {
    if (!store.canSync()) return;
    for (const rec of await all()) {
      if (rec.state === 'deleted' || !rec.data) continue;
      await put({ ...rec, sha: reseed ? null : rec.sha, state: 'pending' });
    }
    await flush();
  }

  function init(retryMs = 30000) {
    window.addEventListener('online', () => flush());
    setInterval(() => { if (pendingCount) flush(); }, retryMs);
    recount();
  }

  return { add, remove, urls, cachedThumb, flush, mirror, pushAll, init, pending: () => pendingCount, isPhotoPath: (p) => p.startsWith(`${DIR}/`) };
}
