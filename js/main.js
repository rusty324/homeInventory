// App shell: tabs via the URL hash, the sync badge, and re-rendering the
// active tab whenever the store reports a change.

import { h, $, clear } from './ui.js';
import { badgeState } from '../ghsync/settings-ui.js';
import { store, pendingUploads, initBlobs } from './sync.js';
import * as paint from './paint.js';
import * as breakers from './breakers.js';
import * as inventory from './inventory.js';
import * as maintenance from './maintenance.js';
import * as settings from './settings.js';
import { initTips } from './tips.js';

const TABS = {
  paint: { title: 'Paint', mod: paint },
  breakers: { title: 'Breakers', mod: breakers },
  inventory: { title: 'Inventory', mod: inventory },
  maintenance: { title: 'Maintenance', mod: maintenance },
  settings: { title: 'Settings', mod: settings },
};

let current = null;

function route() {
  const id = location.hash.slice(1);
  const tab = TABS[id] ? id : 'paint';
  if (tab === current) return;
  current = tab;
  for (const a of document.querySelectorAll('[data-tab]')) {
    a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  }
  const view = clear($('#view'));
  view.dataset.tab = tab;
  view.tips = null; // a tab may set its own hover-help table (Settings does)
  TABS[tab].mod.mount(view);
  document.title = `${TABS[tab].title} · Home Records`;
}

function renderBadge() {
  const { text, cls } = badgeState(store);
  const n = pendingUploads();
  const badge = $('#badge');
  badge.className = `gh-badge ${cls}`;
  badge.textContent = n && cls !== 'error' ? `${text} · ${n} upload${n === 1 ? '' : 's'} pending` : text;
  // Overdue tasks + warranties ending soon, on the Maintenance tab, so it's
  // visible from anywhere.
  const { count: n2, title } = maintenance.attention();
  const count = $('#overdue-count');
  count.textContent = n2 ? String(n2) : '';
  count.hidden = !n2;
  count.title = title;
  badge.title = store.syncStatus().error?.message || '';
}

// Coalesce bursts of change events (a refresh can emit one per collection).
let queued = false;
function rerender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    // Don't yank the DOM out from under an open form or an in-progress edit.
    if (document.querySelector('dialog[open]')) { setTimeout(rerender, 400); return; }
    TABS[current]?.mod.refresh();
    renderBadge();
  });
}

store.onChange((e) => {
  if (e.type === 'sync-status') {
    renderBadge();
    // Settings shows the sync problem inline; its refresh only touches
    // status text, never the forms, so it's safe to run on every status change.
    if (current === 'settings') settings.refresh();
  }
  else rerender();
});

$('#badge').addEventListener('click', () => { location.hash = 'settings'; });
window.addEventListener('hashchange', route);
route();
renderBadge();
store.init();
initBlobs();
initTips();
