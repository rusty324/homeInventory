# Notes for Claude Code

Static GitHub Pages app, no build step, no dependencies, native ES modules.
See README.md for the feature overview and layout.

- Data goes through `js/sync.js` (ghsync store, `appId: 'homeinv'`). Read
  `ghsync/CLAUDE.md` before touching sync; its invariants apply here — in
  particular never commit a `data/` folder to this public repo, and never
  render the token into the DOM.
- New collection: add it to `files` in `js/sync.js` (it is encrypted
  automatically) and to the backup/restore, which iterates `store.files`.
- Binary attachments are not collection fields. Records hold `photoIds` or
  `manuals` entries; the bytes live at `data/photos/<id>.json` /
  `data/files/<id>.json` via `ghsync/blobs.js`. Use `photoEditor()`/`docsEditor()`
  in forms: `commit()` uploads new ones, then save the record, then
  `finish()` deletes removed ones; on a failed save call `discard()` (deletes
  what `commit()` uploaded). Never delete before the record is saved. Use
  `dropPhotos()`/`dropDocs()` after the record's delete has succeeded.
  Restore deletes attachments only the replaced records referenced
  (`attachmentRefs()` in `js/settings.js`); `node tests/attachments.mjs`. Render user URLs only through `safeUrl()`.
- Warranty reminders are derived from `item.warrantyUntil` (see
  `js/warranty.js`), never stored as maintenance tasks — keep it that way so
  editing the date on the item is the only thing needed.
- Breaker `fixtures` are `{ name, roomId }` (`roomId: ''` = all of the
  breaker's rooms). Older records stored plain strings; `migrate.breakers` in
  `js/sync.js` converts them on read, so code may assume the object shape.
  The fixture list (`js/fixtures.js`) is the `fixtures` collection plus any
  name already used on a breaker; breakers reference fixtures by name, so
  renaming/deleting in the list rewrites the breakers (case-insensitive).
  A list entry's optional `roomId` is only the default for new breaker rows;
  changing it never rewrites existing breakers.
  A handle tie is `tiedBelow: true` on the upper single-pole breaker only;
  the lower one's tie is derived (`tiedAbove` in `js/breakers.js`).
- Hover help: every form field needs a help text. Texts live in `js/tips.js`,
  one table per form, keyed by the field's label; pass the table to
  `openModal({ tips })`. Adding or renaming a field label means adding or
  renaming its entry, or the field silently gets no tooltip.
- Each tab module exports `mount(root)` (build toolbar once) and `refresh()`
  (re-render results from the store). `main.js` calls `refresh()` on store
  changes, deferred while a dialog is open.
- `await saveRecord(...)` in every form's `onSave`. It rejects only when
  localStorage is full (the edit was not kept); un-awaited, the dialog closed
  and looked saved.
- `openModal` asks before discarding an edited form (Esc, ✕, Cancel). Code
  that closes a form itself should check `dialog.isDirty()` first.
- Costs are plain numbers; `money()` shows them in the currency set under
  Settings → Display (`homeinv.currency`, a display setting only).
- Occasional toolbar actions go in `overflowMenu()` (ui.js), not a new row.
- Calendar feed (`js/calendar-feed.js`): an opt-in **secret gist** a calendar
  can subscribe to, republished a few seconds after task/item changes. Anyone
  with its URL can read it, so it is built with `buildIcs({ shared: true })`
  (no notes, serials or warranty details). Uses the sync token, which needs
  "Gists: read and write". Keep private fields out of the shared build.
- Backup "with photos & files" embeds attachments as base64; restore puts
  them back with `blobs.restore(id, rec)` (only if missing everywhere).
- Text on a solid `--danger` fill uses `--on-danger` (white fails contrast
  in dark mode). `node tests/features.mjs` checks dark-mode contrast.
- `sw.js` + `js/offline.js`: the app opens with no connection (network-first,
  this site's own files only — never the GitHub API). `node tests/offline.mjs`.
- Run `node tests/e2e.mjs` after changes (needs `playwright` resolvable from
  the repo; `node_modules/` is gitignored). After touching sync, also run
  `node tests/http-cache.mjs` (real HTTPS + browser HTTP cache).
- `ghsync/` is also shipped standalone (`node tools/pack-ghsync.mjs` builds
  `ghsync.zip`), so keep it free of homeInventory specifics. After changing
  it, run `node ghsync/tests/ghsync.test.mjs` and add a line to
  `ghsync/CHANGELOG.md`.
