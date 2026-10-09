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
  `data/files/<id>.json` via `js/blobs.js`. Use `photoEditor()`/`docsEditor()`
  in forms (they defer uploads to `commit()`), and `dropPhotos()`/`dropDocs()`
  when deleting a record. Render user URLs only through `safeUrl()`.
- Warranty reminders are derived from `item.warrantyUntil` (see
  `js/warranty.js`), never stored as maintenance tasks — keep it that way so
  editing the date on the item is the only thing needed.
- Breaker `fixtures` are `{ name, roomId }` (`roomId: ''` = all of the
  breaker's rooms). Older records stored plain strings; `migrate.breakers` in
  `js/sync.js` converts them on read, so code may assume the object shape.
  A handle tie is `tiedBelow: true` on the upper single-pole breaker only;
  the lower one's tie is derived (`tiedAbove` in `js/breakers.js`).
- Hover help: every form field needs a help text. Texts live in `js/tips.js`,
  one table per form, keyed by the field's label; pass the table to
  `openModal({ tips })`. Adding or renaming a field label means adding or
  renaming its entry, or the field silently gets no tooltip.
- Each tab module exports `mount(root)` (build toolbar once) and `refresh()`
  (re-render results from the store). `main.js` calls `refresh()` on store
  changes, deferred while a dialog is open.
- Run `node tests/e2e.mjs` after changes (needs `playwright` resolvable from
  the repo; `node_modules/` is gitignored). After touching sync, also run
  `node tests/http-cache.mjs` (real HTTPS + browser HTTP cache).
