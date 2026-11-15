// Write-through localStorage cache, namespaced per app so two ghsync apps
// served from the same origin (github.io) never collide. Keys:
//   <ns>.data.<path>  JSON string of the file content
//   <ns>.sha.<path>   last known remote blob sha
//   <ns>.queue        JSON array of dirty paths awaiting push
//   <ns>.dirtyids     JSON { path: [record ids edited since the last push] }

export function createCache(namespace) {
  const DATA = `${namespace}.data.`;
  const SHA = `${namespace}.sha.`;
  const QUEUE = `${namespace}.queue`;
  const IDS = `${namespace}.dirtyids`;

  // Plain closures rather than methods, so callers can destructure them
  // without losing `this`.
  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE)) ?? [];
    } catch {
      return [];
    }
  }

  function allDirtyIds() {
    try {
      return JSON.parse(localStorage.getItem(IDS)) ?? {};
    } catch {
      return {};
    }
  }

  // ids: an array, or null to forget what is tracked for the path.
  function setDirtyIds(path, ids) {
    const all = allDirtyIds();
    if (ids) all[path] = ids;
    else delete all[path];
    try {
      localStorage.setItem(IDS, JSON.stringify(all));
    } catch {
      // Storage is full: stop tracking rather than track wrongly. Untracked
      // means "every local record counts as edited", the pre-1.3 behaviour.
      delete all[path];
      try { localStorage.setItem(IDS, JSON.stringify(all)); } catch { localStorage.removeItem(IDS); }
    }
  }

  return {
    dataPrefix: DATA,
    getQueue,

    getData(path) {
      const raw = localStorage.getItem(DATA + path);
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    setData(path, value) {
      localStorage.setItem(DATA + path, JSON.stringify(value));
    },

    getSha(path) {
      return localStorage.getItem(SHA + path);
    },

    setSha(path, sha) {
      if (sha) localStorage.setItem(SHA + path, sha);
      else localStorage.removeItem(SHA + path);
    },

    markDirty(path) {
      const q = getQueue();
      if (!q.includes(path)) {
        q.push(path);
        localStorage.setItem(QUEUE, JSON.stringify(q));
      }
    },

    clearDirty(path) {
      localStorage.setItem(QUEUE, JSON.stringify(getQueue().filter((p) => p !== path)));
      setDirtyIds(path, null);
    },

    // Which records of a dirty collection file were edited (added, changed
    // or removed) since its last push: an array of ids, or null when that
    // isn't known — a path queued by an older version, a whole-file write,
    // or a reseed. The conflict merge reads this; see store.js mergeRemote().
    getDirtyIds(path) {
      const ids = allDirtyIds()[path];
      return Array.isArray(ids) ? ids : null;
    },
    setDirtyIds,

    isDirty(path) {
      return getQueue().includes(path);
    },
  };
}
