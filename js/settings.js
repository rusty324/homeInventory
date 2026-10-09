// Settings: ghsync's data-repo / token / encryption sections, the shared room
// list, and a JSON backup (records only — photos and files live in the data repo).

import { h, clear, toast, confirmDialog } from './ui.js';
import { syncSections, setupRows } from '../ghsync/settings-ui.js';
import { store, pendingUploads } from './sync.js';
import { roomsManager } from './rooms.js';
import { fixturesManager, fixtureList } from './fixtures.js';
import { SETTINGS_TIPS } from './tips.js';

let root;
let openId = null;
let live = null; // nodes a background refresh may update in place

export function mount(el) {
  root = el;
  root.tips = SETTINGS_TIPS;
  render();
}

// Background refresh (sync finished, data changed elsewhere). Updates only the
// room list and status text in place: rebuilding the forms would wipe a token
// or password the user is halfway through typing. The sync sections are
// rebuilt only after the user's own actions (settings-ui's reopen()).
export function refresh() {
  if (!root || !live?.rooms.isConnected) return;
  live.rooms.replaceChildren(roomsManager());
  live.roomCount.textContent = `${store.get('rooms').length}`;
  live.fixtures.replaceChildren(fixturesManager());
  if (live.fixtureCount) live.fixtureCount.textContent = `${fixtureList().length}`;
  const pending = pendingUploads();
  live.pending.textContent = `${pending} photo/file change(s) waiting to upload.`;
  live.pending.hidden = !pending;
  // The badge's tooltip carries the last error, but phones have no hover —
  // so spell it out here, with a retry.
  const { status, error } = store.syncStatus();
  const queued = store.cache.getQueue().length;
  const problem = status === 'error' || (status === 'pending' && (error || queued));
  live.problem.hidden = !problem;
  live.problemText.textContent = problem
    ? `${status === 'error' ? 'Sync error' : `${queued} file(s) waiting to upload`}${error ? `: ${error.message}` : ''}`
    : '';
  const { enabled, locked } = store.encryption();
  if (live.privacy) live.privacy.textContent = locked ? '🔒 locked' : enabled ? 'encryption on' : 'encryption off';
}

function render() {
  const keepOpen = [...root.querySelectorAll('details[open]')].map((d) => d.dataset.section);
  clear(root);
  const reveal = (id) => {
    const d = root.querySelector(`details[data-section="${id}"]`);
    if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };
  const sections = [
    ...syncSections({
      store,
      toast,
      onChange: () => store.emit({ type: 'changed', collection: 'external' }),
      reopen: (id) => { openId = id; render(); },
      text: {
        repoPlaceholder: 'home-data',
        previewFile: 'inventory.json',
        tokenScopeNote: 'A fine-grained personal access token with access to only your private data repo, '
          + 'permission Contents: read and write. It needs no access to this site’s public repo.',
        privacyOff: 'Optional: encrypt records, photos and files (AES-256-GCM) before they are committed to the data repo.',
      },
    }),
    { id: 'rooms', name: 'Rooms & spaces', state: '', body: null },
    { id: 'fixtures', name: 'Fixtures & loads', state: '', body: null },
    { id: 'backup', name: 'Backup', state: '', body: backupSection() },
  ];
  const problemText = h('span');
  live = {
    rooms: h('div'), roomCount: null, fixtures: h('div'), fixtureCount: null, pending: h('p', { class: 'muted' }), privacy: null, problemText,
    problem: h('div', { class: 'sync-problem', role: 'status' }, problemText,
      h('button', { type: 'button', class: 'btn small secondary', onclick: async (e) => {
        e.target.disabled = true;
        await store.flushQueue();
        await store.refresh();
        e.target.disabled = false;
        refresh();
      } }, 'Retry now')),
  };
  root.append(
    h('div', { class: 'card flat setup' },
      h('h2', {}, 'Sync setup'),
      h('p', { class: 'muted' }, 'Without a data repo everything stays in this browser only. Connect a private GitHub repo to back up and sync across devices.'),
      ...setupRows(store, reveal),
      live.pending,
      live.problem),
    ...sections.map((s) => h('details', {
      class: 'settings-section',
      dataset: { section: s.id },
      open: s.id === openId || keepOpen.includes(s.id),
    },
    h('summary', {}, h('span', { class: 'sec-name' }, s.name), stateNode(s)),
    h('div', { class: 'settings-body' }, s.id === 'rooms' ? live.rooms : s.id === 'fixtures' ? live.fixtures : s.body))),
    h('details', { class: 'settings-section', dataset: { section: 'help' } },
      h('summary', {}, h('span', { class: 'sec-name' }, 'How syncing works')),
      h('div', { class: 'settings-body' },
        h('ol', {},
          h('li', {}, 'Create a new ', h('strong', {}, 'private'), ' repository on GitHub (e.g. home-data). It can be empty.'),
          h('li', {}, 'GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Repository access: only that repo. Permissions: Contents → Read and write.'),
          h('li', {}, 'Enter the repo and paste the token above, then press “Upload all local data” once.'),
          h('li', {}, 'On each other device, enter the same repo and a token; data downloads automatically.'),
          h('li', {}, 'iPhone: an app added to the Home Screen keeps its own storage, separate from Safari — set up sync there too (or restore a backup).')),
        h('p', { class: 'muted' }, 'Records are stored as JSON in the folder you choose (default data/), with photos/ and files/ subfolders for photos and uploaded documents. One private repo can hold several apps’ data in different folders. A public repo would expose everything — the app warns if you pick one. Edits made offline are queued and pushed when you reconnect. GitHub keeps history, so deleted data remains in old commits until the repo itself is deleted.'))),
  );
  openId = null;
  refresh();
}

function stateNode(section) {
  const el = h('span', { class: 'sec-state' }, section.state);
  if (section.id === 'rooms') live.roomCount = el;
  if (section.id === 'fixtures') live.fixtureCount = el;
  if (section.id === 'privacy') live.privacy = el;
  return el;
}

function backupSection() {
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const cols = data?.collections;
      if (!cols || typeof cols !== 'object') throw new Error('Not a home-inventory backup file');
      const names = Object.keys(store.files).filter((c) => Array.isArray(cols[c]));
      if (!names.length) throw new Error('The backup contains no records');
      const counts = names.map((c) => `${cols[c].length} ${c}`).join(', ');
      if (!(await confirmDialog(`Replace current data with ${counts}? This overwrites what is in this browser (and the data repo, if connected).`, { okLabel: 'Replace' }))) return;
      for (const c of names) await store.save(c, cols[c].filter((r) => r && typeof r.id === 'string'));
      toast('Backup restored');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  const exportJson = () => {
    const collections = Object.fromEntries(Object.keys(store.files).map((c) => [c, store.get(c)]));
    const blob = new Blob([JSON.stringify({ app: 'homeinv', version: 1, exportedAt: new Date().toISOString(), collections }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `home-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  return h('div', {},
    h('p', { class: 'muted' }, 'Download every record as one JSON file, or restore from one. Photos and uploaded files are not included — they live in the data repo (and this browser).'),
    h('div', { class: 'field-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: exportJson }, 'Download backup'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => fileInput.click() }, 'Restore backup…')),
    fileInput);
}
