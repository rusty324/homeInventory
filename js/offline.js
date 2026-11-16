// Registers sw.js (offline start — see that file) and makes sure it holds
// the whole app, not just what this visit happened to load.
//
// `warm` are modules loaded on demand (the other tabs, the heatmap, file
// import): importing them here pulls each one's imports in too. `extra` are
// files nothing imports (the vendored map library). Everything the page has
// fetched by then is handed to the worker, since most of it was loaded
// before the worker existed.
export function installOffline({ warm = [], extra = [] } = {}) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* http, private mode: stay online-only */ });
  navigator.serviceWorker.ready.then(async (reg) => {
    await Promise.all(warm.map((url) => import(url).catch(() => {})));
    const urls = [
      location.href.split('#')[0],
      ...performance.getEntriesByType('resource').map((e) => e.name),
      ...extra.map((u) => new URL(u, location.href).href),
    ];
    reg.active?.postMessage({ type: 'precache', urls: [...new Set(urls)] });
  }).catch(() => {});
}
