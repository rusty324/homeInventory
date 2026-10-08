// ghsync — a GitHub-backed private data store for static sites.
//
// One factory call gives you cache-first reads, write-through saves with
// sha-checked PUTs, an offline dirty queue, background refresh, per-record
// conflict merging, and optional password encryption. Nothing here is
// specific to any app: pass your own collections and it works.
//
// Write ownership (the reason browser/Actions conflicts can't happen):
// every repo file must have exactly one writer. The browser owns everything
// in `files`; if a workflow in the data repo writes other paths, keep those
// paths out of `files` and read them through readFile()/refreshDir().
// The merge path below only ever handles browser-vs-browser (second device
// or tab) conflicts, merged per record id with local dirty records winning.
// Note: a record deleted locally can resurrect from such a merge; accepted
// for a single-user tool.

import { createCache } from './cache.js';
import {
  makeClient, createTokenStore, ConflictError, NotFoundError, AuthError, NotConfiguredError,
} from './github-api.js';
import { encryptJson, decryptJson, isEnvelope } from './crypto.js';

export { ConflictError, NotFoundError, AuthError, NotConfiguredError };

/**
 * @param {object} opts
 * @param {string}   opts.appId       localStorage namespace, e.g. 'notes'.
 * @param {object}   opts.files       collection -> repo path, all browser-owned.
 * @param {string[]} [opts.encrypted] collections encrypted when a password is set.
 * @param {(path:string)=>boolean} [opts.encryptPath] extra predicate for
 *                   app-owned paths outside `files` (e.g. month shards).
 * @param {object}   [opts.migrate]   collection -> (record)=>record, applied on read.
 * @param {object}   [opts.defaultRepo] {owner, repo, branch} or null for local-only.
 * @param {()=>string[]} [opts.extraPaths] app-owned repo paths to include when
 *                   re-encrypting or seeding a new repo.
 * @param {()=>Promise<boolean>} [opts.onRefresh] called at the end of refresh();
 *                   return true if it changed anything.
 * @param {number}   [opts.retryMs]   dirty-queue retry interval (0 disables).
 */
export function createStore(opts) {
  const {
    appId,
    files,
    encrypted = [],
    encryptPath = () => false,
    migrate = {},
    defaultRepo = null,
    extraPaths = () => [],
    onRefresh = async () => false,
    retryMs = 30000,
  } = opts;

  const REPO_KEY = `${appId}.datarepo`;
  const PW_KEY = `${appId}.enc.pw`;
  const cache = createCache(appId);
  const tokens = createTokenStore(`${appId}.pat`);

  // ---------- data repository ----------
  // Personal data lives in a separate PRIVATE repo, never the public one that
  // serves the app. It's configured at runtime so switching repos needs no
  // redeploy; the client reads this getter on every call, so a change in
  // Settings takes effect immediately.

  function getDataRepo() {
    try {
      const stored = JSON.parse(localStorage.getItem(REPO_KEY));
      if (stored?.owner && stored?.repo) return { branch: 'main', ...stored };
    } catch {
      // fall through to the default
    }
    return defaultRepo;
  }

  function setDataRepo(cfg) {
    if (cfg?.owner && cfg?.repo) {
      localStorage.setItem(REPO_KEY, JSON.stringify({
        owner: cfg.owner.trim(),
        repo: cfg.repo.trim(),
        branch: (cfg.branch || 'main').trim(),
      }));
    } else {
      localStorage.removeItem(REPO_KEY);
    }
  }

  function hasDataRepo() {
    const c = getDataRepo();
    return !!(c?.owner && c?.repo);
  }

  // Remote sync needs both a token and a destination.
  const canSync = () => tokens.has() && hasDataRepo();

  const client = makeClient(getDataRepo, tokens);
  const listeners = new Set();
  let status = 'local'; // 'local' | 'ok' | 'pending' | 'error'
  let lastError = null;

  // ---------- encryption (optional password) ----------
  // When a password is set, the `encrypted` collections (and anything
  // encryptPath() claims) are written as AES-GCM envelopes — see crypto.js.
  // The local cache is always plaintext: the device is trusted, same as the PAT.

  const lockedPaths = new Set(); // envelopes we couldn't decrypt (no/wrong password)
  const password = () => localStorage.getItem(PW_KEY) || '';

  function setPassword(pw) {
    if (pw) localStorage.setItem(PW_KEY, pw);
    else localStorage.removeItem(PW_KEY);
  }

  function encryption() {
    return { enabled: !!password(), locked: lockedPaths.size > 0 };
  }

  const encryptedPaths = () => encrypted.map((c) => files[c]);
  function isEncryptedPath(path) {
    return encryptedPaths().includes(path) || encryptPath(path);
  }

  // Repo-file (de)serialization boundary — the ONLY place ciphertext exists.
  async function serializeFile(path, data) {
    const body = password() && isEncryptedPath(path) ? await encryptJson(data, password()) : data;
    return JSON.stringify(body, null, 2) + '\n';
  }

  // -> { data } on success, { locked: true } when an envelope can't be opened.
  async function deserializeFile(path, parsed) {
    if (!isEnvelope(parsed)) {
      lockedPaths.delete(path);
      return { data: parsed };
    }
    if (password()) {
      try {
        const data = await decryptJson(parsed, password());
        lockedPaths.delete(path);
        return { data };
      } catch {
        // fall through to locked
      }
    }
    lockedPaths.add(path);
    return { locked: true };
  }

  function emit(event) {
    for (const fn of listeners) fn(event);
  }

  function setStatus(s, err = null) {
    status = s;
    lastError = err;
    emit({ type: 'sync-status', status: s, error: err });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function syncStatus() {
    return { status, error: lastError, connected: canSync() };
  }

  // Recompute the badge state from current settings. Called after the token or
  // data repo changes so the UI reflects it immediately, rather than staying
  // stale until the next sync happens to run.
  function refreshStatus() {
    setStatus(canSync() ? (cache.getQueue().length ? 'pending' : 'ok') : 'local');
  }

  // ---------- reads ----------

  function get(collection) {
    const data = cache.getData(files[collection]) ?? [];
    const fn = migrate[collection];
    return fn ? data.map(fn) : data;
  }

  // ---------- writes ----------

  async function save(collection, records) {
    const path = files[collection];
    cache.setData(path, records);
    cache.markDirty(path);
    emit({ type: 'changed', collection });
    await push(path, collection);
  }

  async function upsert(collection, record) {
    const records = get(collection).slice();
    const i = records.findIndex((r) => r.id === record.id);
    if (i >= 0) records[i] = record;
    else records.push(record);
    await save(collection, records);
  }

  async function remove(collection, id) {
    await save(collection, get(collection).filter((r) => r.id !== id));
  }

  async function push(path, collection) {
    if (!canSync() || !navigator.onLine) {
      setStatus(canSync() ? 'pending' : 'local');
      return;
    }
    setStatus('pending');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const content = await serializeFile(path, cache.getData(path));
        try {
          const sha = await client.putFile(path, content, cache.getSha(path), `Update ${path}`);
          cache.setSha(path, sha);
          cache.clearDirty(path);
          setStatus(cache.getQueue().length ? 'pending' : 'ok');
          return;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          await mergeRemote(path, collection);
        }
      }
      throw new Error(`Gave up pushing ${path} after repeated conflicts`);
    } catch (e) {
      if (e instanceof AuthError) setStatus('error', e);
      else setStatus('pending', e); // network or transient: stays queued
    }
  }

  async function mergeRemote(path, collection) {
    let remote = [];
    let sha = null;
    try {
      const f = await client.getFile(path);
      const res = await deserializeFile(path, JSON.parse(f.content));
      // Locked remote = encrypted under a password we don't have; merging is
      // impossible and overwriting would destroy data. Stay dirty and queued.
      if (res.locked) throw new Error(`Cannot merge ${path}: encrypted with an unknown password`);
      remote = res.data;
      sha = f.sha;
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const local = cache.getData(path) ?? [];
    const byId = new Map();
    for (const r of remote) byId.set(r.id, r);
    for (const r of local) byId.set(r.id, r); // local dirty records win
    cache.setData(path, [...byId.values()]);
    cache.setSha(path, sha);
    if (collection) emit({ type: 'changed', collection });
  }

  // Retry everything still dirty (called on 'online' and on a timer).
  async function flushQueue() {
    for (const path of cache.getQueue()) {
      const collection = Object.keys(files).find((k) => files[k] === path);
      await push(path, collection);
    }
  }

  // ---------- background refresh ----------

  async function refresh() {
    if (!canSync() || !navigator.onLine) return;
    try {
      for (const [collection, path] of Object.entries(files)) {
        if (cache.isDirty(path)) continue; // don't clobber unpushed local edits
        try {
          const { content, sha } = await client.getFile(path);
          if (sha !== cache.getSha(path)) {
            const res = await deserializeFile(path, JSON.parse(content));
            if (res.locked) {
              // Keep the old cache and old sha so we retry once unlocked.
              emit({ type: 'sync-status', status, error: lastError });
              continue;
            }
            cache.setData(path, res.data);
            cache.setSha(path, sha);
            emit({ type: 'changed', collection });
          }
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e; // absent file = empty collection
        }
      }
      await onRefresh();
      if (!cache.getQueue().length) setStatus('ok');
    } catch (e) {
      if (e instanceof AuthError) setStatus('error', e);
      // other failures: keep whatever we had cached
    }
  }

  // ---------- raw file access (for app-owned paths outside `files`) ----------

  const readFile = (path) => cache.getData(path);

  // Write an app-owned path through the same cache/queue/encryption path as a
  // collection. Used for sharded data (one file per month, say) that doesn't
  // fit the collection model.
  async function writeFile(path, data) {
    cache.setData(path, data);
    cache.markDirty(path);
    await push(path, null);
  }

  // Pull every file in a repo directory into the cache. Returns the paths seen
  // and whether anything changed. Locally-dirty paths are skipped so an
  // unpushed local write isn't clobbered by the remote.
  async function refreshDir(dir, match = () => true) {
    const paths = [];
    let changed = false;
    for (const entry of await client.listDir(dir)) {
      if (!match(entry.name)) continue;
      paths.push(entry.path);
      if (cache.isDirty(entry.path) || entry.sha === cache.getSha(entry.path)) continue;
      const { content, sha } = await client.getFile(entry.path);
      const res = await deserializeFile(entry.path, JSON.parse(content));
      if (res.locked) {
        emit({ type: 'sync-status', status, error: lastError });
        continue;
      }
      cache.setData(entry.path, res.data);
      cache.setSha(entry.path, sha);
      changed = true;
    }
    return { paths, changed };
  }

  // ---------- migrations and seeding ----------

  // Re-upload cached collections to the data repo. `collections` defaults to
  // the encryptable ones, which is what enabling/disabling a password needs;
  // pass all of `files` to seed a freshly-created repo from this browser.
  // extraPaths() are rewritten too; when one of them is Actions-owned these
  // migration writes are the documented exception, and a conflict is ignored
  // because the workflow will reconverge on its next run.
  async function rewriteEncryptedFiles(collections = encrypted) {
    if (!canSync()) return; // local mode, or no repo configured yet
    for (const collection of collections) {
      const path = files[collection];
      cache.markDirty(path);
      await push(path, collection);
    }
    for (const path of extraPaths()) {
      const data = cache.getData(path);
      if (!Array.isArray(data)) continue; // never had it decrypted — skip
      const content = await serializeFile(path, data);
      try {
        const sha = await client.putFile(path, content, cache.getSha(path), `Update ${path}`);
        cache.setSha(path, sha);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }

  // Seed a newly configured data repo with everything this browser holds.
  // Shas are cleared first so each file is created rather than sha-checked
  // against a different repo's history.
  async function pushAllData() {
    if (!canSync()) throw new Error('Set a data repository and a token first');
    for (const path of Object.values(files)) cache.setSha(path, null);
    for (const path of extraPaths()) cache.setSha(path, null);
    await rewriteEncryptedFiles(Object.keys(files));
  }

  // ---------- lifecycle ----------

  function init() {
    window.addEventListener('online', () => flushQueue());
    // Cross-tab: another tab wrote localStorage — re-render rather than merge later.
    window.addEventListener('storage', (e) => {
      if (e.key?.startsWith(cache.dataPrefix)) emit({ type: 'changed', collection: 'external' });
    });
    if (retryMs) {
      setInterval(() => {
        if (cache.getQueue().length) flushQueue();
      }, retryMs);
    }
    setStatus(canSync() ? (cache.getQueue().length ? 'pending' : 'ok') : 'local');
    refresh(); // fire-and-forget background load
  }

  return {
    // configuration
    getDataRepo, setDataRepo, hasDataRepo,
    getToken: tokens.get, setToken: tokens.set, hasToken: tokens.has,
    setPassword, encryption,
    // data
    get, save, upsert, remove,
    // status and events
    onChange, emit, syncStatus, refreshStatus, canSync,
    // sync
    refresh, flushQueue, rewriteEncryptedFiles, pushAllData, init,
    // escape hatches for app-owned paths
    client, cache, readFile, writeFile, refreshDir, push,
    serializeFile, deserializeFile, isEncryptedPath,
    files,
  };
}
