# ghsync changelog

## 1.3 — 2026-11-15

- **A conflict merge let every local record win, not just the edited ones.**
  A device holding a stale copy (offline for a while, or editing before its
  startup refresh landed) therefore reverted whatever another device had
  changed since, and brought back what it had deleted — silently, with a
  green badge. `save()` now records which record ids it added, changed or
  removed (`cache.getDirtyIds(path)`, cleared when the push lands), and the
  merge lets only those win; a record deleted here stays deleted, and one
  deleted elsewhere is no longer resurrected. A path with no such list —
  queued by 1.2, written whole with `writeFile`, or reseeded with
  `pushAllData()` — and a repo with no such file still merge as before
  (union, local wins), so nothing local is dropped on a guess.
- Re-encrypting (`rewriteEncryptedFiles`) edits no record, so on a conflict
  it now keeps the repo's records rather than overwriting them.

## 1.2 — 2026-11-03

Every change below has a test in `tests/ghsync.test.mjs` that fails on 1.1.

### Never overwrite a file it doesn't understand

- **A collection file that isn't a list was treated as empty and overwritten
  by the next merge.** The common way to get one is two apps pointed at the
  same folder (1.1 made folders configurable): the merge replaced the other
  app's file with this app's records. Now a non-list file — or a list with
  records that have no `id`, which the merge would collapse into one — is
  refused with `ShapeError`: nothing is written, the local copy is kept, the
  edit stays queued, and it uploads once the file is fixed, moved or deleted.
  `null` still reads as empty: that's what pre-1.1 copies wrote for an unused
  collection, and there is nothing in it to lose.
- **Refresh loaded a non-list file straight into a collection**, so `get()`
  returned an object and the app's next `upsert` threw. Refresh now leaves the
  local copy alone for that file, loads the rest, and reports it.

### "sync error" means a person should look

- **Non-transient failures showed as "pending sync" forever** — giving up after
  repeated conflicts, a merge that can't decrypt, `ShapeError`, a bug. Only
  failures that clear by themselves are `pending` now: `NetworkError` (new: no
  HTTP response at all, previously a bare `TypeError`), `ServerError` (new:
  5xx) and `RateLimitError`. Everything else is `error`. Either way the write
  stays queued and keeps retrying.
- A background refresh that hits a non-transient error now reports it instead
  of failing silently. A dropped connection during refresh still changes
  nothing, so a momentary blip doesn't make a healthy badge look broken.

### Error details you can copy

- `errorReport(store)` (settings-ui.js): plain-text diagnostics — the error and
  its class, file, HTTP status and cause, when it started, repo/folder/branch,
  what's queued, encryption state, browser, ghsync version. Never contains the
  token or the password; the token is also scrubbed from the text.
- `errorPanel(store, { toast, onRetry })`: that report in a read-only box with
  **Copy** and **Retry now**, for the host to show in its own modal.
- `badgeState()` also returns `title` (the error message) and `actionable`
  (there's an error worth showing): make the badge a button then. The example
  app opens the panel in a `<dialog>` when "sync error" is clicked.
- `syncStatus()` also returns `errorAt` and `queued`. `VERSION` is exported
  from `store.js`.

## 1.1 — 2026-10-13

Bug review against 1.0 (the original `ghsync.zip`). Every fix below has a test
in `tests/ghsync.test.mjs` or `tests/http-cache.test.mjs` that fails on 1.0.

### Data-loss and stuck-sync fixes

- **An older push finishing last could drop a newer edit.** Two quick edits to
  one file each started a PUT; if the older one finished last it marked the
  file clean and the newer edit was never uploaded. Pushes of a path are now
  serialized, and a file is only marked clean if its cache still equals what
  was sent.
- **A refresh landing during an edit could overwrite it.** `refresh()` checked
  for unpushed edits before downloading, not after; an edit made during the
  download was replaced by the remote copy. It now re-checks (dirty flag,
  in-flight push, sha) after the download and decryption.
- **Overlapping flushes uploaded the same file several times** (online event +
  timer + Retry). Coalesced by the per-path serialization above.
- **Second device stuck on "pending" after "Upload all".** GitHub API reads are
  HTTP-cacheable for 60 s, so the conflict path re-read a stale sha and every
  retry failed. All reads now use `cache: 'no-store'`.
- **`"null"` collection files.** Seeding wrote `null` for collections a device
  had never loaded, overwriting other devices' data; merging into such a file
  then failed. Never-loaded collections are no longer written, and merges
  treat a non-array file as empty.
- **Seeding raced an in-flight refresh.** `pushAllData()` and
  `rewriteEncryptedFiles()` now wait for it.

### Error handling

- **Files over ~100 KB failed to sync** (`RangeError` in base64 encoding).
  Encoding is now chunked (`github-api.js`, `crypto.js`).
- **Files over 1 MB read as empty.** `getFile()` falls back to the raw media
  type above the Contents API's inline limit.
- **A GitHub rate limit showed as a bad token.** 403/429 rate limits are now
  `RateLimitError`: status stays `pending` and the queue retries.
- **Any 422 was treated as a sha conflict** and retried three times. Only a
  422 about the sha is a conflict now; others are `RequestError` carrying
  GitHub's message.
- **One unreadable file stopped the whole refresh**, silently. Each file is
  loaded independently; bad JSON is reported as `CorruptFileError` naming the
  file, and the local copy is kept.
- **A full localStorage lost edits silently.** Saves now reject with
  `StorageFullError` and the status says so.
- **A wrong password was kept after a failed unlock**, so the next write
  would encrypt with it and leave files under two passwords.
  `setPassword()` returns the previous password and the settings UI reverts.
- **"Upload all" reported success with files still queued.** The settings UI
  now says the upload didn't finish, with the cause.

### Added

- Configurable folder in the data repo (`dir`, default `data`, `/` for the
  root), so one private repo can hold several apps. Public-repo warning in
  settings.
- `client.deleteFile()`.
- `blobs.js`: photos and documents as one repo file each, with an IndexedDB
  mirror, encrypted like collections. Includes `processImage()` (downscale +
  thumbnail) and `processDocument()`. It now re-runs a flush that was
  triggered mid-flush, and stops a flush at the first rate limit.
- `tests/`: the package's own Playwright suites (18 + 8 checks).
- `START-HERE.md` and an agent-facing `CLAUDE.md` with no app-specific content.

### Known limitations (unchanged)

- A record deleted on one device can come back if another device had unpushed
  edits to the same file (merge is per id, local wins). Use a tombstone field
  if that matters.
- Each write re-uploads the whole collection file; shard big collections.
- GitHub keeps history: deleting in the app doesn't erase old commits.
