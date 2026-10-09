// Binary attachments (photos, manuals, receipts) live outside the ghsync
// collection model: one file per attachment at <dir>/<id>.json in the data
// repo, and an IndexedDB mirror locally. Records only hold attachment ids.
//
// Why not a collection field: localStorage tops out around 5 MB, and every
// collection write re-uploads the whole file, so base64 blobs inside
// inventory.json would make each edit slow and break the cache quickly.
//
// The browser is the only writer of these directories (ghsync invariant 1).
// Files go through store.serializeFile/deserializeFile, so they are encrypted
// exactly when the collections are (sync.js claims the paths in encryptPath).
// Each attachment is immutable per id; editing means add-new + remove-old.

import { NotFoundError, ConflictError, AuthError } from '../ghsync/store.js';

// ---------- IndexedDB ----------
// Records: { id, mime, data, thumb?, name?, size?, sha, state: 'synced' | 'pending' | 'deleted' }

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(dbp, mode, fn) {
  return dbp.then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('blobs', mode);
    const req = fn(t.objectStore('blobs'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}

// ---------- input processing ----------

const MAX_EDGE = 1600;
const THUMB_EDGE = 240;
const MAX_B64 = 520_000; // ~390 KB JPEG keeps photo sync and page loads quick
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

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

// Image File -> { mime, data, thumb } (base64, no data: prefix), downscaled.
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

// Any File -> { mime, name, size, data } stored as-is (PDF manuals etc.).
export function processDocument(file) {
  if (file.size > MAX_DOC_BYTES) {
    return Promise.reject(new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_DOC_BYTES / 1048576} MB. Link to it instead.`));
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({
      mime: file.type || 'application/octet-stream',
      name: file.name,
      size: file.size,
      data: String(r.result).split(',')[1] || '',
    });
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

// ---------- the store ----------

/**
 * @param {object} store  the ghsync store
 * @param {object} o
 * @param {string} o.dbName IndexedDB database name (namespace it with appId)
 * @param {string} o.dir    repo directory, e.g. 'data/photos'
 * @param {string} o.kind   collection name used in 'changed' events
 */
export function createBlobStore(store, { dbName, dir, kind }) {
  const dbp = openDb(dbName);
  const get = (id) => tx(dbp, 'readonly', (s) => s.get(id));
  const put = (rec) => tx(dbp, 'readwrite', (s) => s.put(rec));
  const del = (id) => tx(dbp, 'readwrite', (s) => s.delete(id));
  const all = () => tx(dbp, 'readonly', (s) => s.getAll());
  const pathOf = (id) => `${dir}/${id}.json`;
  const inflight = new Map();
  const thumbs = new Map(); // id -> thumb data: URL, so re-renders paint without an IDB round trip
  let flushing = null;
  let pendingCount = 0;

  const changed = () => store.emit({ type: 'changed', collection: kind });

  async function recount() {
    const n = (await all()).filter((r) => r.state !== 'synced').length;
    if (n !== pendingCount) {
      pendingCount = n;
      store.emit({ type: 'sync-status', ...store.syncStatus() });
    }
  }

  // Returns the new id immediately; the upload happens in the background (or
  // waits in the queue while offline/local-only).
  async function add(processed) {
    const id = crypto.randomUUID();
    await put({ id, ...processed, sha: null, state: 'pending' });
    flush();
    return id;
  }

  async function remove(id) {
    const rec = await get(id);
    thumbs.delete(id);
    if (!rec) {
      // Never downloaded here, but it may exist remotely: queue the delete.
      await put({ id, sha: null, state: 'deleted' });
    } else if (rec.state === 'pending' && !rec.sha) {
      await del(id); // never uploaded
    } else {
      await put({ id, sha: rec.sha, state: 'deleted' });
    }
    flush();
  }

  // The full record, fetched lazily from the repo when this device doesn't
  // have it yet. -> record or null.
  async function load(id) {
    let rec = await get(id);
    if (!rec?.data && rec?.state !== 'deleted' && store.canSync() && navigator.onLine) {
      if (!inflight.has(id)) inflight.set(id, download(id).finally(() => inflight.delete(id)));
      try {
        rec = await inflight.get(id);
      } catch (e) {
        console.warn(`${kind} fetch failed`, id, e);
        rec = null;
      }
    }
    return rec?.data ? rec : null;
  }

  // -> { full, thumb } data: URLs for images, or null if unavailable.
  async function urls(id) {
    const rec = await load(id);
    if (!rec) return null;
    const thumb = `data:${rec.mime};base64,${rec.thumb || rec.data}`;
    thumbs.set(id, thumb);
    return { full: `data:${rec.mime};base64,${rec.data}`, thumb };
  }

  // -> Blob for opening/downloading a document, or null.
  async function blob(id) {
    const rec = await load(id);
    if (!rec) return null;
    return (await fetch(`data:${rec.mime};base64,${rec.data}`)).blob();
  }

  const cachedThumb = (id) => thumbs.get(id) || null;

  async function download(id) {
    const path = pathOf(id);
    const { content, sha } = await store.client.getFile(path);
    const res = await store.deserializeFile(path, JSON.parse(content));
    if (res.locked) return null;
    const rec = { id, ...res.data, sha, state: 'synced' };
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
    const { id, sha: oldSha, state, ...payload } = rec;
    const content = await store.serializeFile(path, payload);
    let sha;
    try {
      sha = await store.client.putFile(path, content, oldSha, `Add ${path}`);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // Immutable per id, so a conflict only means our sha is stale (e.g. a
      // re-encrypt from another device). Overwrite with ours.
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
          console.warn(`${kind} push failed`, rec.id, e);
        }
      }
    } finally {
      await recount();
    }
  }

  // Called from store.refresh(): push our queue, then pull anything another
  // device added. Everything is mirrored (not just fetched on view) so a
  // password change can re-encrypt every file from local copies. Never
  // deletes local copies for files missing remotely — a freshly connected
  // empty repo would otherwise wipe this device's files before "Upload all
  // local data" seeds it.
  async function mirror() {
    if (!store.canSync() || !navigator.onLine) return false;
    await flush();
    const local = new Map((await all()).map((r) => [r.id, r]));
    let any = false;
    for (const entry of await store.client.listDir(dir)) {
      const m = /^(.+)\.json$/.exec(entry.name);
      if (!m) continue;
      const rec = local.get(m[1]);
      if (rec && (rec.state !== 'synced' || rec.sha === entry.sha)) continue;
      try {
        if (await download(m[1])) any = true;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        console.warn(`${kind} download failed`, entry.path, e);
      }
    }
    if (any) changed();
    return any;
  }

  // Re-upload every local file: after a password change (re-encrypt), or with
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

  return {
    add, remove, load, urls, blob, cachedThumb, flush, mirror, pushAll, init,
    pending: () => pendingCount,
    owns: (p) => p.startsWith(`${dir}/`),
  };
}
