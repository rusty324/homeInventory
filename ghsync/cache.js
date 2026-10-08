// Write-through localStorage cache, namespaced per app so two ghsync apps
// served from the same origin (github.io) never collide. Keys:
//   <ns>.data.<path>  JSON string of the file content
//   <ns>.sha.<path>   last known remote blob sha
//   <ns>.queue        JSON array of dirty paths awaiting push

export function createCache(namespace) {
  const DATA = `${namespace}.data.`;
  const SHA = `${namespace}.sha.`;
  const QUEUE = `${namespace}.queue`;

  // Plain closures rather than methods, so callers can destructure them
  // without losing `this`.
  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE)) ?? [];
    } catch {
      return [];
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
    },

    isDirty(path) {
      return getQueue().includes(path);
    },
  };
}
