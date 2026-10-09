# homeInventory

A static GitHub Pages site for keeping house records — no backend, no build
step, no dependencies. Four tools share one set of rooms:

| Tab | What it does |
| --- | --- |
| **Paint** | Log every paint color: brand, color code, sheen, base type, tint base, swatch color, coverage/coats notes, and photos of swatches and can labels. Assign each color to any number of rooms and areas (walls, trim, ceiling…). Search by room, color name, color family, or brand; browse by color or by room. |
| **Breakers** | Multiple panels across one or more properties. A visual panel map (odd slots left, even right) with multi-pole breakers, tandem A/B halves, GFCI / AFCI / dual-function / HACR types, amps, wire gauge and type, custom phase colors for 1-, 2-, and 3-phase panels, and links from a breaker to the sub-panel it feeds. Link breakers to rooms and fixtures, then search “which breaker do I flip?”. Print a legend sized to any paper (letter, A4, 4×6, custom) with per-label font scaling — use the browser’s “Save as PDF”. |
| **Inventory** | A sortable table of belongings: name, brand, model #, serial #, acquisition date, cost, description, location, pictures, manuals (web links or uploaded files up to 10 MB), and warranty expiry with details (quick-fill +1/2/3/5 years from purchase). Filter by warranty status. Running total and CSV export for insurance. |
| **Maintenance** | Recurring or one-time upkeep tasks (HVAC filter, water heater flush, alarm tests…) with an interval, last-done date, parts/supplies, and a log of completions with notes and cost. Grouped into overdue / due soon / later, with an overdue count on the tab. Tasks can link to a room and an inventory item, whose manuals then show on the task. Starter list of common tasks, and an `.ics` export so your calendar does the reminding (a static site can’t send notifications). Inventory warranties ending within 60 days (or ended in the last 30) are listed here too, count toward the tab badge within 30 days, and go into the `.ics` export with an alarm 30 days ahead. |

Feature notes that started this are in [`features/`](features/).

## Data and sync

Data saving uses [`ghsync/`](ghsync/) (vendored, see its README). In short:

- **Out of the box everything stays in your browser** (localStorage, plus
  IndexedDB for photos and files). Nothing personal is ever written to this public repo.
- To back up and sync across devices, create a **separate private repo** (e.g.
  `home-data`) and a fine-grained personal access token with access to only
  that repo and **Contents: read and write**. Enter both under ⚙ Settings,
  then press **Upload all local data** once.
- **Folder in the repo** (Settings → Data repository) picks where the files go:
  `data` by default, any nested path like `homeinv` or `records/house`, or `/`
  for the repo root. One private repo can hold several apps in different
  folders. Changing it doesn’t move existing files; press **Upload all local
  data** afterwards. Settings warns if the repo you pick is public.
- Records are stored as `<folder>/*.json`; each photo is its own file under
  `<folder>/photos/` (downscaled to a JPEG under ~400 KB), and each uploaded
  document under `<folder>/files/`. Every device keeps a full local copy
  of photos and files (IndexedDB), so a password change can re-encrypt them.
  For big manuals, a link to the manufacturer’s PDF is the lighter option.
- Optional password encryption (AES-256-GCM) covers records, photos and files. There
  is no recovery if the password is lost.
- Works offline: edits queue and push when you reconnect. Two devices editing
  the same file are merged per record; a record deleted on one device can come
  back if another device had unsynced edits to that file (ghsync’s documented
  trade-off).
- **Settings → Backup** downloads/restores all records as one JSON file
  (photos and uploaded files not included).

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
js/blobs.js         photo/document files in the data repo + IndexedDB mirror
js/photo-ui.js      photo thumbnails and editor
js/docs-ui.js       manual links/uploads editor and viewer
js/rooms.js         shared rooms (used by every tool)
js/paint.js         Paint tab
js/breakers.js      Breakers tab (+ printable legend)
js/inventory.js     Inventory tab
js/maintenance.js   Maintenance tab (+ .ics export)
js/warranty.js      warranty status/reminders derived from inventory items
js/dates.js         local calendar-date helpers
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
GitHub Contents API: local-only mode sends nothing, all four tools, seeding a
repo, encryption (no plaintext in any committed file), files over 1 MB read via
the raw media type, a second device,
offline queueing, 409 conflict merges, photo deletion, syncing into a nested
folder (nothing written outside it), the public-repo warning, and no
horizontal scroll at phone width.
