// A calendar feed a phone can subscribe to, so the maintenance schedule and
// warranty dates stay current without re-downloading an .ics file.
//
// A static site can't serve a feed, and calendar apps can't sign in to the
// private data repo. So the feed is a SECRET GIST: unlisted, never shown on
// a profile, and its "raw" URL (without a revision) always serves the
// latest version. The catch is plain: anyone who has the URL can read it.
// So the feed leaves out notes, serial numbers and warranty details
// (buildIcs({ shared: true })), and it is off until switched on here.
//
// It uses the same GitHub token as sync, which then also needs the account
// permission "Gists: read and write". The token stays in localStorage and goes
// only to api.github.com, as for sync; it is never put in the feed URL.

import { store } from './sync.js';
import { buildIcs, icsSources } from './maintenance.js';

const KEY = 'homeinv.icsfeed';
const FILE = 'home-maintenance.ics';
const API = 'https://api.github.com';

export function feedState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && s.gistId ? s : null;
  } catch {
    return null;
  }
}
const save = (s) => { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* blocked */ } };

export class FeedError extends Error {}

async function gh(method, path, body) {
  const token = store.getToken();
  if (!token) throw new FeedError('Add a GitHub token under Data repository first.');
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new FeedError('Couldn’t reach GitHub. Try again when you’re online.');
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new FeedError(method === 'POST'
      ? 'GitHub refused to create the gist. Give the token the account permission “Gists: read and write”, then try again.'
      : 'GitHub refused to update the feed’s gist: the token may lack “Gists: read and write”, or the gist was deleted.');
  }
  if (!res.ok) throw new FeedError(`GitHub answered ${res.status} for the feed.`);
  return res.status === 204 ? null : res.json();
}

function content() {
  const { list, warranties } = icsSources();
  return buildIcs(list, new Date(), warranties, { shared: true });
}

// Creates the gist the first time, updates it after. -> the state.
export async function publishFeed() {
  const prev = feedState();
  const files = { [FILE]: { content: content() } };
  if (prev) {
    await gh('PATCH', `/gists/${prev.gistId}`, { files });
    const next = { ...prev, updatedAt: new Date().toISOString() };
    save(next);
    return next;
  }
  const g = await gh('POST', '/gists', { description: 'Home maintenance calendar (Home Records)', public: false, files });
  const next = {
    gistId: g.id,
    url: `https://gist.githubusercontent.com/${g.owner?.login}/${g.id}/raw/${FILE}`,
    updatedAt: new Date().toISOString(),
  };
  save(next);
  return next;
}

// Deletes the gist, so the URL stops working everywhere it was subscribed.
export async function stopFeed() {
  const s = feedState();
  if (!s) return;
  try {
    await gh('DELETE', `/gists/${s.gistId}`);
  } catch (e) {
    // Already gone counts as stopped; anything else is reported and kept.
    if (!(e instanceof FeedError) || !/deleted/.test(e.message)) throw e;
  }
  save(null);
}

// Keep the feed current: after tasks or items change, republish once things
// settle. Failures here are quiet (the next change retries); Settings shows
// the state and publishing there reports errors.
let timer = null;
export function watchFeed() {
  store.onChange((e) => {
    if (e.type !== 'changed' || !['tasks', 'items', 'external'].includes(e.collection) || !feedState()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { publishFeed().catch(() => {}); }, 8000);
  });
}
