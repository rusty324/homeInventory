# ghsync — notes for Claude Code

Instructions for an agent wiring this package into a static site. `README.md`
next to this file is the human version; read it for the why, read this for the
how. This file is named `CLAUDE.md` rather than `README-claude.md` because
Claude Code loads `CLAUDE.md` automatically when working in this directory —
keep the name if you copy the folder elsewhere.

**What ghsync does:** gives a static site (GitHub Pages, no backend, no build
step) a private, synced, offline-capable data store, by reading and writing
JSON files in a *separate private GitHub repo* through the Contents API.

**Scope of this doc:** integrating the package, extending it, and testing it.
If you are changing this app's own features, the app-specific layer is `js/`
at the repo root — `js/sync.js` creates the store and `js/blobs.js` handles
photo and document files outside the collection model — not this folder.

**Provenance:** vendored from another project. Local changes: chunked base64
in `crypto.js` and `github-api.js` (the spread form threw a RangeError past
~100 KB), `client.deleteFile()`, and a raw-media fallback in `getFile()` for
files over 1 MB. The app's own test is
`tests/e2e.mjs`; it drives the real page with the GitHub API stubbed.

## Files

| File | Read it when |
|---|---|
| `store.js` | Always. `createStore()` is the whole core: reads, writes, push, merge, refresh, encryption. ~400 lines, worth reading end to end. |
| `settings-ui.js` | Wiring the repo/token/password UI, or changing its copy. |
| `github-api.js` | Touching auth, error types, or adding an API call. |
| `cache.js` | Rarely. Namespaced localStorage, no logic. |
| `crypto.js` | Never edit casually — see invariant 5. |
| `example/` | Copy this as the starting point for a new app. Runs standalone from any static server. |
| `../js/sync.js` | Wiring this app to the store: which collections map to which repo paths. |

## Integration recipe

Five steps. Do them in order; do not stop after step 3 (an app with no
Settings UI cannot be configured by its user, and is therefore local-only
forever).

1. Copy the whole `ghsync/` folder to the project root. Do not rename files;
   the modules import each other by relative path.
2. Create the store once, in a module the whole app imports:

   ```js
   import { createStore } from './ghsync/store.js';

   export const store = createStore({
     appId: 'notes',                       // unique per app on the origin
     files: { notes: 'data/notes.json' },  // collection -> path in the data repo
     encrypted: ['notes'],                 // omit if the data isn't personal
   });
   ```
3. Use it: `store.get('notes')` (sync, cache-first, always an array),
   `await store.upsert('notes', record)`, `await store.remove('notes', id)`,
   `store.onChange(handler)`. Records are plain objects with a string `id`.
4. Render the settings sections and a status badge:

   ```js
   import { syncSections, setupRows, badgeState } from './ghsync/settings-ui.js';

   for (const spec of syncSections({ store, toast, onChange: rerender })) {
     // spec = { id, name, state, body }: wrap body in whatever chrome you use
   }
   ```
   Include `ghsync.css` only if the app has no styles for `.btn` / `.field` /
   `.field-row` / `.muted` / `.list-row`.
5. Call `store.init()` once at startup (background load, cross-tab sync,
   offline retry). Then write a test — see Testing below.

`example/app.js` is exactly this, complete, in ~90 lines. Prefer adapting it
over writing from scratch.

## API

`createStore(opts)` options: `appId` and `files` are required; `encrypted`,
`encryptPath(path)`, `migrate` (`{collection: fn}`, applied on read),
`defaultRepo`, `extraPaths()`, `onRefresh()`, `retryMs` are optional. Full
descriptions are in the JSDoc at the top of `store.js`.

Returned:

- Data — `get(collection)` sync; `save(collection, records)`,
  `upsert(collection, record)`, `remove(collection, id)` all async.
- Config — `getDataRepo/setDataRepo/hasDataRepo`, `getToken/setToken/hasToken`,
  `setPassword`, `encryption()` → `{enabled, locked}`.
- Status — `onChange(fn)` → unsubscribe; `syncStatus()` →
  `{status, error, connected}` where status is `'local' | 'ok' | 'pending' |
  'error'`; `refreshStatus()`, `canSync()`, `emit(event)`.
  Events: `{type:'changed', collection}` and `{type:'sync-status', status, error}`.
- Sync — `refresh()`, `flushQueue()`, `rewriteEncryptedFiles(collections?)`,
  `pushAllData()`, `init()`.
- Escape hatches for app-owned paths — `readFile(path)`, `writeFile(path, data)`,
  `refreshDir(dir, nameMatch)` → `{paths, changed}`, `push(path, collection)`,
  `client`, `cache`, `serializeFile`, `deserializeFile`, `isEncryptedPath`, `files`.

`github-api.js` exports `makeClient`, `createTokenStore`, and the error classes
`NotConfiguredError`, `AuthError`, `NotFoundError`, `ConflictError` —
distinguish these by `instanceof`, never by message text.

`crypto.js` exports `encryptJson`, `decryptJson`, `isEnvelope`, `DecryptError`.
It is isomorphic (WebCrypto only), so Node workflows can import the same file.

## Invariants — do not break these

1. **One writer per file.** Every path in the data repo has exactly one writer:
   this browser, or one workflow, never both. If a workflow writes
   `data/activities/`, the browser writes `data/imported/` instead, and
   decisions *about* the workflow's records (edits, links, hidden flags) go in
   a separate browser-owned overlay merged on read. Breaking this reintroduces
   the one conflict class ghsync cannot resolve.
2. **`appId` namespaces everything.** Never hardcode a localStorage key, and
   never reuse another app's `appId` on the same origin — `you.github.io` is
   one origin for every project you host there.
3. **Personal data never goes in the public app repo.** `defaultRepo` stays
   `null` so an unconfigured app is local-only rather than writing somewhere
   public. Never commit a `data/` folder to the app repo; gitignore it.
4. **The token stays out of the DOM.** It lives in localStorage and goes only
   to `api.github.com`. Never render it back into an input's value, log it, or
   put it in a URL.
5. **`crypto.js` copies must stay byte-identical.** If a workflow in the data
   repo also encrypts, it imports its own copy of this exact file. Change one,
   change both, and keep a test asserting equality. (This repo has no such
   workflow today, so there is only one copy.)
   Drift means one side silently cannot read the other's files.
6. **No build step, no CDN, no dependencies.** Pages serves these files
   verbatim. Vendor anything you need instead of adding `<script src=cdn>`.
7. **Reads are synchronous, writes are not.** `get()` returns the cache
   immediately; `save/upsert/remove` resolve when the push has been *attempted*
   (offline, it queues). Await them before asserting anything about the remote.

## Extending

- **Sharded or workflow-written data** (one file per month, say) stays out of
  `files`. Pull it with `refreshDir(dir, name => re.test(name))` from an
  `onRefresh` hook, read/write individual paths with `readFile`/`writeFile`,
  claim them in `encryptPath` if they are personal, and list them in
  `extraPaths()` so encryption migrations and `pushAllData()` cover them.
  `js/blobs.js` at this repo's root is a worked example: one file per photo or
  document under `data/photos/` and `data/files/`, mirrored into IndexedDB
  rather than localStorage.
- **New collection**: add it to `files`, add it to `encrypted` if personal,
  and that's it — the queue, merge, refresh, and seeding all pick it up.
- **New GitHub call**: add it to `makeClient` so it inherits `headers()`,
  `check()`, and the configured-repo guard.
- **Different UI**: `syncSections` returns specs, not markup. Restyle by
  wrapping `spec.body`; reword through the `text` option (`defaultOwner`,
  `repoPlaceholder`, `appRepoNote`, `tokenScopeNote`, `privacyLocked`,
  `privacyOn`, `privacyOff`) rather than forking the file.

## Testing

There is no build and no unit-testable seam worth mocking; test through the
real page in Chromium.

`tests/e2e.mjs` at the repo root is this repo's Playwright suite. Extend it
when you change the core; it drives a real page with `page.route('https://api.github.com/**', …)`
stubbed: 404 reads so writes create, 201 writes, and record every call so you
can assert on the request bodies.

Whatever else you change, keep these covered: nothing is sent to GitHub before
a repo *and* a token exist; every request targets the private repo and never
the app repo; an offline write queues and flushes on reconnect; a 409 merges
both sides by id instead of clobbering; encrypted files leave no plaintext in
the PUT body.

## Failure modes you will actually hit

- **`NotConfiguredError`** — no data repo set. Expected in local-only mode;
  handle it, don't let it surface as a toast on every write.
- **`{locked: true}` / `encryption().locked`** — a file is encrypted with a
  password this browser doesn't have. ghsync keeps the old cache and old sha
  and retries later; never overwrite a locked file, that destroys data.
- **Status stuck on `pending`** — the queue is non-empty. Usually offline, an
  expired token (`AuthError` → `'error'`), or a repo that no longer exists.
- **A deleted record reappearing** — the merge is per id with local winning, so
  a delete on one device can be resurrected by another device's stale copy.
  Accepted trade-off for a single-user tool; use a tombstone field if it
  matters.
- **Large files** — the Contents API only inlines content below 1 MB;
  `getFile` falls back to the raw media type above that (up to 100 MB), but
  every write still re-uploads the whole file. Shard a collection by month or
  key long before it gets big; there is no automatic splitting.
- **GitHub keeps history** — deleting data in the app does not remove it from
  earlier commits. Only deleting the data repo really erases it.
