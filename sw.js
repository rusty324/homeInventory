// Offline start. The data layer already works offline (cache-first reads, a
// queue for writes), but the page itself still needed the network to load —
// no signal in the gym meant no app. This keeps a copy of the app's own
// files as they are fetched and serves it when the network doesn't answer.
//
// Network first, on purpose: Pages deploys by pushing files, and a
// cache-first worker would keep serving the old ones until told otherwise.
// Online, this behaves exactly as if it weren't here.
//
// Only this site's own GET requests are touched. The GitHub API (the data,
// the token) never passes through here.
const CACHE = 'app-shell-v1';
const SLOW_MS = 4000; // a connection that hangs counts as offline

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function fromNetwork(request, cache) {
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The page is always "index.html", whatever the query string says.
    const cached = () => cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    const network = fromNetwork(request, cache);
    const slow = new Promise((resolve) => { setTimeout(resolve, SLOW_MS); });
    try {
      const first = await Promise.race([network, slow.then(() => cached())]);
      if (first) return first;
      return await network; // slow, and nothing cached: keep waiting
    } catch (err) {
      const hit = await cached();
      if (hit) return hit;
      throw err;
    }
  })());
});

// The page that installs this worker loaded before it could see anything, so
// it hands over the list of files it used; they're fetched once more here.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(event.data.urls
      .filter((u) => { try { return new URL(u).origin === self.location.origin; } catch { return false; } })
      .map((u) => fromNetwork(new Request(u), cache).catch(() => {})));
    event.source?.postMessage({ type: 'precached' });
  })());
});
