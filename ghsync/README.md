# ghsync

Give a static site — GitHub Pages, no backend, no build step — a private,
synced, multi-device data store, in about fifteen lines.

Your app is public. Your data isn't: it lives in a **separate private repo**
that the browser reads and writes through the GitHub Contents API with a
fine-grained personal access token, cached in `localStorage` so the app works
offline and loads instantly.

```
public repo (GitHub Pages)          private repo (yours)
   index.html + ghsync/     ──────►    data/notes.json
   no personal data                    data/whatever.json
```

Copy the `ghsync/` folder into any project. It has **no dependencies, no build
step, and no CDN** — native ES modules that GitHub Pages serves verbatim.

## Quick start

```js
import { createStore } from './ghsync/store.js';
import { syncSections, setupRows, badgeState } from './ghsync/settings-ui.js';

const store = createStore({
  appId: 'notes',                       // localStorage namespace
  files: { notes: 'data/notes.json' },  // collection -> path in the data repo
  encrypted: ['notes'],                 // optional: encrypt when a password is set
});

store.init();                           // background load + offline retry

store.get('notes');                                  // -> array, from cache
await store.upsert('notes', { id: 'n1', text: '…' }); // saves + pushes
await store.remove('notes', 'n1');
store.onChange((e) => { /* 'changed' | 'sync-status' */ });
```

Records are plain objects with an `id`. Reads are synchronous (cache-first);
writes update the cache immediately and push in the background, queueing when
offline. With no data repo configured the app is simply local-only — nothing
leaves the browser, and no personal data can ever land in the public repo by
accident.

Drop in the settings UI and users can configure it themselves:

```js
for (const spec of syncSections({ store, toast })) {
  // spec = { id, name, state, body } — render however you like
}
```

`ghsync/example/` is a complete working app (notes, ~90 lines including the
settings panel). Open it from any static server.

## What the user has to do, once

1. Create a **private** repo, e.g. `you/notes-data`. It can be empty — files
   are created on first write.
2. Create a fine-grained PAT scoped to **only that repo**, with **Contents:
   read and write** (add **Actions: read and write** only if your data repo
   runs workflows you want to trigger from the app).
3. Open Settings in the app, enter owner/repo, paste the token, press
   **Upload all local data** once to seed the repo.

The token never leaves the browser except in requests to `api.github.com`.

## `createStore(options)`

| option | required | meaning |
| --- | --- | --- |
| `appId` | ✓ | `localStorage` namespace. Two ghsync apps on `you.github.io` must differ. |
| `files` | ✓ | `{ collection: 'data/path.json' }`. Every one is browser-owned. |
| `encrypted` | | Collections encrypted when the user sets a password. |
| `encryptPath(path)` | | Same, for app-owned paths outside `files`. |
| `migrate` | | `{ collection: (record) => record }`, applied on read. |
| `defaultRepo` | | `{owner, repo, branch}`, or `null` (default) for local-only. |
| `extraPaths()` | | App-owned paths to include when re-encrypting or seeding. |
| `onRefresh()` | | Hook at the end of `refresh()` for app-owned directories. |
| `retryMs` | | Dirty-queue retry interval, default 30s. `0` disables. |

Returned: `get save upsert remove` · `getDataRepo setDataRepo hasDataRepo` ·
`getToken setToken hasToken` · `setPassword encryption` · `onChange emit
syncStatus refreshStatus canSync` · `refresh flushQueue rewriteEncryptedFiles
pushAllData init` · and the escape hatches `client cache readFile writeFile
refreshDir push serializeFile deserializeFile isEncryptedPath files`.

### Data that doesn't fit collections

Sharded or workflow-written data (say `data/activities/2026-07.json` written by
a scheduled Action) stays out of `files`. Use `refreshDir(dir, nameMatch)` to
pull a directory into the cache, `readFile`/`writeFile` for individual paths,
and declare them in `extraPaths()` so encryption migrations cover them.

## The one rule: every file has exactly one writer

Give each repo file a single writer — the browser, or a workflow, never both.
Then a conflict between them is structurally impossible, and you never need a
merge strategy for the case that actually loses data. If a workflow writes
`data/activities/`, let the browser write `data/imported/` instead, and keep
decisions *about* those records (edits, links, hidden flags) in a separate
browser-owned overlay file that's merged on read.

ghsync does handle browser-vs-browser conflicts — a second device or tab —
by re-fetching on a sha mismatch and merging per record `id`, with local
unpushed records winning. A record deleted on one device can resurrect from
such a merge; that's an accepted trade for a single-user tool.

## Encryption (optional)

Set a password and the `encrypted` collections are written as AES-256-GCM
envelopes (PBKDF2-SHA256, 310k iterations) instead of plaintext JSON. The
local cache stays plaintext — the device is trusted, exactly like the PAT.

`crypto.js` is isomorphic (WebCrypto only, no DOM, no `localStorage`), so a
Node workflow in the data repo can read and write the same format: copy it
next to your script and `import` it there. If you do, keep the two copies
byte-identical and add a test that asserts it — silent drift would make one
side unable to read the other's files.

There is no recovery: a lost password means unreadable data. Say so in your UI.

## Security notes

- The PAT sits in `localStorage`. Anything that can run script on your origin
  can read it — so don't inject untrusted HTML, and scope the token to the one
  private repo so a leak can't touch anything else.
- GitHub keeps full history: data deleted in the app stays in the repo's
  commits. Deleting the data repo is the only real erase.
- Everything is per-browser: a new device starts local-only until the user
  enters the repo and token again.

## Copying it into another app

1. Copy the `ghsync/` folder to your project root.
2. `createStore({ appId, files })` with your own collections — pick an `appId`
   that no other app of yours uses.
3. Render `syncSections({ store, toast })` somewhere. Include `ghsync.css` if
   your app has no styles of its own for `.btn` / `.field` / `.list-row`.
4. Point the app at a **new private repo** (a second app should not share the
   first one's data repo, since `pushAllData` seeds the whole `data/` tree).

Working on this with an AI assistant? `CLAUDE.md` in this folder is the
agent-facing version — the integration recipe, the invariants that must hold,
and the failure modes — and Claude Code loads it automatically.

Files: `store.js` (core) · `github-api.js` (Contents API client) · `cache.js`
(namespaced localStorage) · `crypto.js` (isomorphic AES-GCM) · `settings-ui.js`
(drop-in panel) · `ghsync.css` · `example/`.
