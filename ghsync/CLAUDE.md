# ghsync — notes for Claude Code

Instructions for an agent wiring this package into a static site. `README.md`
next to this file is the human version (the why); this is the how.
`START-HERE.md` is the one-page setup checklist. Keep this file named
`CLAUDE.md`: Claude Code loads it automatically when working in this folder.

**What ghsync does:** gives a static site (GitHub Pages, no backend, no build
step) a private, synced, offline-capable data store, by reading and writing
JSON files in a *separate private GitHub repo* through the Contents API.

**Version:** see `CHANGELOG.md`. If this folder is vendored into an app, the
app's own sync wiring lives outside it (conventionally `js/sync.js`); change
that, not these files, for app features.

## Files

| File | Read it when |
|---|---|
| `store.js` | Always. `createStore()` is the whole core: reads, writes, push, merge, refresh, encryption. ~500 lines, worth reading end to end. |
| `settings-ui.js` | Wiring the repo/token/password UI, or changing its copy. Also exports `h()`, a tiny DOM helper. |
| `github-api.js` | Touching auth, error types, or adding an API call. |
| `blobs.js` | The app stores photos or files. One repo file per attachment + IndexedDB mirror. |
| `cache.js` | Rarely. Namespaced localStorage, no logic. |
| `crypto.js` | Never edit casually — see invariant 5. |
| `example/` | Copy this as the starting point for a new app. Runs standalone from any static server. |
| `tests/` | Run after any change here — see Testing. |

## Integration recipe

Do every step; do not stop after step 3 (an app with no settings UI cannot be
configured by its user, and is therefore local-only forever).

1. Copy the whole `ghsync/` folder to the project root. Do not rename files;
   the modules import each other by relative path.
2. Create the store once, in a module the whole app imports (`js/sync.js`):

   ```js
   import { createStore } from '../ghsync/store.js';

   export const store = createStore({
     appId: 'notes',                       // unique per app on the origin
     files: { notes: 'data/notes.json' },  // collection -> path in the data repo
     encrypted: ['notes'],                 // omit if the data isn't personal
   });
   ```
3. Use it: `store.get('notes')` (sync, cache-first, always an array),
   `await store.upsert('notes', record)`, `await store.remove('notes', id)`,
   `store.onChange(handler)`. Records are plain objects with a string `id`
   (`crypto.randomUUID()`).
4. Render the settings sections and a status badge:

   ```js
   import { syncSections, setupRows, badgeState } from '../ghsync/settings-ui.js';

   for (const spec of syncSections({ store, toast, onChange: rerender, reopen })) {
     // spec = { id, name, state, body }: wrap body in whatever chrome you use
   }
   ```
   Include `ghsync.css` only if the app has no styles for `.btn` / `.field` /
   `.field-row` / `.muted` / `.list-row`.
5. Call `store.init()` once at startup (background load, cross-tab sync,
   offline retry). Re-render on `onChange` events.
6. Add `.gitignore` entries for `data/` and `node_modules/`, and copy
   `tests/ghsync.test.mjs`'s approach for an app-level test (see Testing).

`example/app.js` is exactly steps 2–5, complete, in ~100 lines. Prefer
adapting it over writing from scratch.

## API

`createStore(opts)` options: `appId` and `files` are required; `encrypted`,
`encryptPath(path)`, `migrate` (`{collection: fn}`, applied on read),
`defaultRepo`, `extraPaths()`, `onRefresh()`, `retryMs` are optional. Full
descriptions are in the JSDoc at the top of `store.js`.

Returned:

- Data — `get(collection)` sync; `save(collection, records)`,
  `upsert(collection, record)`, `remove(collection, id)` async. They reject
  **only** on a local failure (`StorageFullError`: localStorage is full and
  the edit was not kept). Sync problems never reject; they go to the status.
- Config — `getDataRepo/setDataRepo/hasDataRepo`, `getToken/setToken/hasToken`,
  `setPassword(pw)` → previous password, `encryption()` → `{enabled, locked}`.
- Status — `onChange(fn)` → unsubscribe; `syncStatus()` →
  `{status, error, connected}` where status is `'local' | 'ok' | 'pending' |
  'error'`; `refreshStatus()`, `canSync()`, `emit(event)`.
  Events: `{type:'changed', collection}` and `{type:'sync-status', status, error}`.
  `'pending'` = queued, will retry by itself (offline, 5xx, rate limit).
  `'error'` = needs the user (bad token, rejected request, full storage,
  unreadable file in the repo).
- Sync — `refresh()`, `flushQueue()`, `rewriteEncryptedFiles(collections?)`,
  `pushAllData()`, `init()`.
- Escape hatches for app-owned paths — `readFile(path)`, `writeFile(path, data)`,
  `refreshDir(dir, nameMatch)` → `{paths, changed}`, `push(path, collection)`,
  `client`, `cache`, `serializeFile`, `deserializeFile`, `isEncryptedPath`, `files`.

Error classes (exported from `store.js`; distinguish by `instanceof`, never by
message text): `NotConfiguredError`, `AuthError` (401/403), `NotFoundError`,
`ConflictError` (409, or a 422 about the sha), `RateLimitError` (403/429 rate
limit — transient), `RequestError` (400/other 422 — GitHub rejected the
request; carries GitHub's message), `StorageFullError`, `CorruptFileError`.

`blobs.js` exports `createBlobStore(store, { dbName, dir, kind })` and the
input helpers `processImage(file)` (downscale to JPEG + thumbnail),
`processDocument(file)`, `MAX_DOC_BYTES`.

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
   change both, and keep a test asserting equality. Drift means one side
   silently cannot read the other's files.
6. **No build step, no CDN, no dependencies.** Pages serves these files
   verbatim. Vendor anything you need instead of adding `<script src=cdn>`.
7. **Reads are synchronous, writes are not.** `get()` returns the cache
   immediately; `save/upsert/remove` resolve when the push has been *attempted*
   (offline, it queues). Await them before asserting anything about the remote.
8. **Every GitHub read is `cache: 'no-store'`.** GitHub marks API responses
   cacheable for 60 s; a cached re-read after a write returns the old sha and
   every conflict retry fails. `tests/http-cache.test.mjs` guards this.
9. **Pushes of one path are serialized** (`push()` chains per path) and a file
   is only marked clean if its cache still equals what was sent. Don't add a
   second write path that bypasses `push()` for files in `files`.
10. **Big binaries are not collection fields.** localStorage holds ~5 MB and
    every collection write re-uploads the whole file. Store an id in the
    record and the bytes through `blobs.js`.

## Extending

- **New collection**: add it to `files`, add it to `encrypted` if personal,
  and that's it — the queue, merge, refresh, and seeding all pick it up. If
  the app has a backup/restore, iterate `store.files` so it's included.
- **Changing a record's shape**: add a `migrate[collection]` function that
  upgrades old records on read; never rewrite the repo file in bulk.
- **Photos / documents**: `createBlobStore(store, { dbName: '<appId>.photos',
  dir: 'data/photos', kind: 'photos' })`. Claim the dir in `encryptPath`
  (`(p) => p.startsWith('data/photos/')`), call `blobs.mirror()` from
  `onRefresh`, `blobs.init()` at startup, and wrap `pushAllData` /
  `rewriteEncryptedFiles` to also call `blobs.pushAll(reseed)`. Records hold
  ids only; call `blobs.remove(id)` when deleting the record.
- **Sharded or workflow-written data** (one file per month, say) stays out of
  `files`. Pull it with `refreshDir(dir, name => re.test(name))` from an
  `onRefresh` hook, read/write individual paths with `readFile`/`writeFile`,
  claim them in `encryptPath` if personal, and list them in `extraPaths()` so
  encryption migrations and `pushAllData()` cover them.
- **New GitHub call**: add it to `makeClient` so it inherits `headers()`,
  `check()`, the configured-repo guard, `no-store`, and the folder mapping —
  build URLs with `url(path)`, never from `base()` directly, or the call will
  ignore the user's chosen folder.
- **Data folder**: app code always uses logical `data/…` paths. `dir` in the
  data-repo config (`'data'` default, `'/'` root, any nested path; see
  `normalizeDir`) decides where they land. `listDir` maps results back.
- **Different UI**: `syncSections` returns specs, not markup. Restyle by
  wrapping `spec.body`; reword through the `text` option (`defaultOwner`,
  `repoPlaceholder`, `appRepoNote`, `tokenScopeNote`, `privacyLocked`,
  `privacyOn`, `privacyOff`) rather than forking the file.

## Testing

No build and no unit-testable seam worth mocking: test through a real page in
Chromium. Needs the `playwright` package resolvable (e.g.
`npm i -D playwright`; in Claude Code cloud sessions Chromium is preinstalled).

- `node ghsync/tests/ghsync.test.mjs` — the package's own suite, against the
  example app with an in-memory fake GitHub. Includes deterministic race tests
  (the fake can pause a request with `gate()` and fail one with `failNext()`).
  Run after any change in this folder; add a failing test before fixing a bug.
- `node ghsync/tests/http-cache.test.mjs` — the same fake over real HTTPS with
  GitHub's cache headers, because `page.route()` disables the browser's HTTP
  cache. Needs `openssl` and permission to bind 127.0.0.1:443 (prints SKIP
  otherwise). Run after touching `github-api.js` or the merge path.

For the app itself, write a Playwright test that stubs
`page.route('https://api.github.com/**', …)` the same way (copy the fake from
`ghsync.test.mjs`) and keep these covered: nothing is sent to GitHub before a
repo *and* a token exist; every request targets the private repo and never the
app repo; an offline write queues and flushes on reconnect; a 409 merges both
sides by id instead of clobbering; encrypted files leave no plaintext in the
PUT body.

## Failure modes you will actually hit

- **`NotConfiguredError`** — no data repo set. Expected in local-only mode;
  handle it, don't let it surface as a toast on every write.
- **`{locked: true}` / `encryption().locked`** — a file is encrypted with a
  password this browser doesn't have. ghsync keeps the old cache and old sha
  and retries later; never overwrite a locked file, that destroys data. The
  settings UI reverts a password that doesn't unlock.
- **Status stuck on `pending`** — the queue is non-empty: offline, rate
  limited, GitHub 5xx. `syncStatus().error` says which. Settings shows it with
  a "Retry now" button.
- **Status `error`** — expired/wrong-scope token (`AuthError`), a request
  GitHub rejects (`RequestError`), full localStorage (`StorageFullError`), or
  a hand-edited file that isn't valid JSON (`CorruptFileError`; the local copy
  is kept and the other files still load — fix or delete the file in the repo).
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
- **iOS home-screen apps** have storage separate from Safari: the user has to
  connect the repo again there.
