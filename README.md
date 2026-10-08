# homeInventory

A static GitHub Pages site for keeping house records — no backend, no build
step, no dependencies. Three tools share one set of rooms:

| Tab | What it does |
| --- | --- |
| **Paint** | Log every paint color: brand, color code, sheen, base type, tint base, swatch color, coverage/coats notes, and photos of swatches and can labels. Assign each color to any number of rooms and areas (walls, trim, ceiling…). Search by room, color name, color family, or brand; browse by color or by room. |
| **Breakers** | Multiple panels across one or more properties. A visual panel map (odd slots left, even right) with multi-pole breakers, tandem A/B halves, GFCI / AFCI / dual-function / HACR types, amps, wire gauge and type, custom phase colors for 1-, 2-, and 3-phase panels, and links from a breaker to the sub-panel it feeds. Link breakers to rooms and fixtures, then search “which breaker do I flip?”. Print a legend sized to any paper (letter, A4, 4×6, custom) with per-label font scaling — use the browser’s “Save as PDF”. |
| **Inventory** | A sortable table of belongings: name, brand, model #, serial #, acquisition date, cost, description, location, and pictures. Running total and CSV export for insurance. |

Feature notes that started this are in [`features/`](features/).

## Data and sync

Data saving uses [`ghsync/`](ghsync/) (vendored, see its README). In short:

- **Out of the box everything stays in your browser** (localStorage, plus
  IndexedDB for photos). Nothing personal is ever written to this public repo.
- To back up and sync across devices, create a **separate private repo** (e.g.
  `home-data`) and a fine-grained personal access token with access to only
  that repo and **Contents: read and write**. Enter both under ⚙ Settings,
  then press **Upload all local data** once.
- Records are stored as `data/*.json` in the private repo; each photo is its own
  file under `data/photos/`, downscaled to a JPEG under ~400 KB.
- Optional password encryption (AES-256-GCM) covers records and photos. There
  is no recovery if the password is lost.
- Works offline: edits queue and push when you reconnect. Two devices editing
  the same file are merged per record; a record deleted on one device can come
  back if another device had unsynced edits to that file (ghsync’s documented
  trade-off).
- **Settings → Backup** downloads/restores all records as one JSON file
  (photos not included).

## Publishing

Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick
`main` and `/ (root)`. The site is served from `index.html`; `.nojekyll` makes
Pages serve the files as-is.

To run locally, serve the folder with any static server (ES modules don’t load
from `file://`), e.g. `python3 -m http.server` and open http://localhost:8000.

## Layout

```
index.html          app shell (tabs)
css/app.css         all styles, light + dark
js/main.js          routing, sync badge, re-render on change
js/sync.js          the ghsync store: collections → data/*.json
js/photos.js        photo files in the data repo + IndexedDB mirror
js/rooms.js         shared rooms (used by all three tools)
js/paint.js         Paint tab
js/breakers.js      Breakers tab (+ printable legend)
js/inventory.js     Inventory tab
js/settings.js      sync settings, rooms, backup
ghsync/             vendored sync package
tests/e2e.mjs       Playwright end-to-end test (GitHub API stubbed)
```

## Tests

```
npm i -D playwright   # or link an existing install into node_modules/
node tests/e2e.mjs
```

The test drives the real page in Chromium against an in-memory fake of the
GitHub Contents API: local-only mode sends nothing, all three tools, seeding a
repo, encryption (no plaintext in any committed file), a second device,
offline queueing, 409 conflict merges, photo deletion, and no horizontal
scroll at phone width.
