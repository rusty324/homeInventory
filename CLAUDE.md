# Notes for Claude Code

Static GitHub Pages app, no build step, no dependencies, native ES modules.
See README.md for the feature overview and layout.

- Data goes through `js/sync.js` (ghsync store, `appId: 'homeinv'`). Read
  `ghsync/CLAUDE.md` before touching sync; its invariants apply here — in
  particular never commit a `data/` folder to this public repo, and never
  render the token into the DOM.
- New collection: add it to `files` in `js/sync.js` (it is encrypted
  automatically) and to the backup/restore, which iterates `store.files`.
- Photos are not collection fields: records hold `photoIds`; files live at
  `data/photos/<id>.json` via `js/photos.js`. Use `photoEditor()` in forms
  and `dropPhotos()` when deleting a record.
- Each tab module exports `mount(root)` (build toolbar once) and `refresh()`
  (re-render results from the store). `main.js` calls `refresh()` on store
  changes, deferred while a dialog is open.
- Run `node tests/e2e.mjs` after changes (needs `playwright` resolvable from
  the repo; `node_modules/` is gitignored).
