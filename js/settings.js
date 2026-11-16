// Settings: ghsync's data-repo / token / encryption sections, the shared room
// list, and a JSON backup (records, and optionally the photos and files too).
// Restoring puts back attachments the backup carries and deletes the ones
// only the replaced records used.

import { dropPhotos } from './photo-ui.js';
import { dropDocs } from './docs-ui.js';
import { photos, docs } from './sync.js';
import { feedState, publishFeed, stopFeed } from './calendar-feed.js';
import { today } from './dates.js';
import { h, clear, toast, confirmDialog, currency, setCurrency, money } from './ui.js';
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
    { id: 'display', name: 'Display', state: currency(), body: displaySection() },
    { id: 'calfeed', name: 'Calendar feed', state: feedState() ? 'on' : 'off', body: feedSection() },
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

function feedSection() {
  const box = h('div');
  const draw = () => {
    const st = feedState();
    const status = h('p', { class: 'muted feed-status' });
    const run = (fn, ok) => async (e) => {
      e.target.disabled = true;
      try { await fn(); toast(ok); } catch (err) { toast(err.message, 'error'); }
      draw();
    };
    clear(box);
    box.append(
      h('p', { class: 'muted' }, 'Subscribe to your maintenance schedule and warranty end dates from a phone or computer calendar, so it stays up to date by itself — unlike the .ics download, which is a one-off copy.'),
      h('p', { class: 'muted' }, h('strong', {}, 'Anyone with the feed’s link can read it. '),
        'It is a secret GitHub gist: unlisted and unguessable, but not private. The feed holds task names, categories, parts and dates, and warranty items’ names, brands and models. It leaves out notes, serial numbers and warranty details. It uses your GitHub token, which also needs the account permission “Gists: read and write”.'),
    );
    if (!st) {
      box.append(h('div', { class: 'field-row' }, h('button', { type: 'button', class: 'btn', onclick: run(publishFeed, 'Calendar feed published') }, 'Publish calendar feed')));
      return;
    }
    const url = h('input', { type: 'text', readonly: true, value: st.url, 'aria-label': 'Calendar feed URL' });
    status.textContent = `Last updated ${new Date(st.updatedAt).toLocaleString()}. It updates by itself a few seconds after you change a task or an item.`;
    box.append(
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Feed URL'), url),
      h('div', { class: 'field-row' },
        h('a', { class: 'btn', href: st.url.replace(/^https:/, 'webcal:') }, 'Subscribe in Calendar'),
        h('button', { type: 'button', class: 'btn secondary', onclick: async () => { try { await navigator.clipboard.writeText(st.url); toast('Feed link copied'); } catch { url.select(); } } }, 'Copy link'),
        h('button', { type: 'button', class: 'btn secondary', onclick: run(publishFeed, 'Calendar feed updated') }, 'Update now'),
        h('button', { type: 'button', class: 'btn danger', onclick: async (e) => { if (await confirmDialog('Stop the feed? Its gist is deleted and every calendar subscribed to it stops updating.', { okLabel: 'Stop feed' })) run(stopFeed, 'Calendar feed stopped')(e); } }, 'Stop feed')),
      status,
    );
  };
  draw();
  return box;
}

const CURRENCIES = [
  ['USD', 'US dollar'], ['CAD', 'Canadian dollar'], ['EUR', 'Euro'], ['GBP', 'Pound sterling'],
  ['AUD', 'Australian dollar'], ['NZD', 'New Zealand dollar'], ['CHF', 'Swiss franc'], ['JPY', 'Japanese yen'],
  ['SEK', 'Swedish krona'], ['NOK', 'Norwegian krone'], ['DKK', 'Danish krone'], ['MXN', 'Mexican peso'], ['INR', 'Indian rupee'],
];

function displaySection() {
  const cur = currency();
  const sel = h('select', { 'aria-label': 'Currency' },
    ...(CURRENCIES.some(([c]) => c === cur) ? [] : [h('option', { value: cur }, cur)]),
    ...CURRENCIES.map(([c, name]) => h('option', { value: c }, `${c} — ${name}`)));
  sel.value = cur;
  const sample = h('span', { class: 'muted' }, `e.g. ${money(1234.5)}`);
  sel.addEventListener('change', () => {
    setCurrency(sel.value);
    sample.textContent = `e.g. ${money(1234.5)}`;
    toast(`Amounts now show in ${sel.value}`);
  });
  return h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Currency'), sel),
    h('p', { class: 'muted' }, 'How costs are shown. It does not convert anything: amounts are stored as plain numbers. Saved on this device.'),
    sample);
}

// Attachment ids referenced by these record lists: photoIds on any record,
// and uploaded files in `manuals`.
function attachmentRefs(lists) {
  const photos = new Set();
  const files = new Set();
  for (const list of lists) {
    for (const r of list) {
      for (const id of r?.photoIds || []) photos.add(id);
      for (const d of r?.manuals || []) if (d?.kind === 'file' && d.fileId) files.add(d.fileId);
    }
  }
  return { photos, files };
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
      if (!cols || typeof cols !== 'object' || (data.app && data.app !== 'homeinv')) throw new Error('Not a home-inventory backup file');
      const names = Object.keys(store.files).filter((c) => Array.isArray(cols[c]));
      if (!names.length) throw new Error('The backup contains no records');
      const counts = names.map((c) => `${cols[c].length} ${c}`).join(', ');
      if (!(await confirmDialog(`Replace current data with ${counts}? This overwrites what is in this browser (and the data repo, if connected).`, { okLabel: 'Replace' }))) return;
      const before = attachmentRefs(names.map((c) => store.get(c)));
      for (const c of names) await store.save(c, cols[c].filter((r) => r && typeof r.id === 'string'));
      // A backup made "with photos & files" carries them: put back any the
      // restored records use that this device and the repo no longer have.
      let back = 0;
      if (data.attachments && typeof data.attachments === 'object') {
        const want = attachmentRefs(names.map((c) => store.get(c)));
        for (const [id, rec] of Object.entries(data.attachments.photos || {})) if (want.photos.has(id) && await photos.restore(id, rec)) back++;
        for (const [id, rec] of Object.entries(data.attachments.files || {})) if (want.files.has(id) && await docs.restore(id, rec)) back++;
      }
      // Photos and files only the replaced records used are now orphans: in
      // this browser and in the data repo. Delete those — and only those, so
      // anything the restored records still point at stays.
      const after = attachmentRefs(names.map((c) => store.get(c)));
      const gonePhotos = [...before.photos].filter((id) => !after.photos.has(id));
      const goneFiles = [...before.files].filter((id) => !after.files.has(id));
      await dropPhotos(gonePhotos);
      await dropDocs(goneFiles.map((fileId) => ({ kind: 'file', fileId })));
      const n = gonePhotos.length + goneFiles.length;
      const notes = [back && `restored ${back} photo${back === 1 ? '' : 's'}/file${back === 1 ? '' : 's'}`,
        n && `removed ${n} attachment${n === 1 ? '' : 's'} no record uses any more`].filter(Boolean);
      toast(notes.length ? `Backup restored; ${notes.join('; ')}` : 'Backup restored');
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  const exportJson = async (withAttachments = false) => {
    const collections = Object.fromEntries(Object.keys(store.files).map((c) => [c, store.get(c)]));
    const payload = { app: 'homeinv', version: 1, exportedAt: new Date().toISOString(), collections };
    let missing = 0;
    if (withAttachments) {
      // The photos and uploaded files the records use, as base64, so the one
      // file is a complete copy. Ones not on this device are fetched from the
      // data repo; any that can't be had are counted, not silently left out.
      const refs = attachmentRefs(Object.values(collections));
      const grab = async (kind, ids) => {
        const out = {};
        for (const id of ids) {
          const rec = await kind.load(id).catch(() => null);
          if (!rec?.data) { missing++; continue; }
          const { mime, data, thumb, name, size } = rec;
          out[id] = Object.fromEntries(Object.entries({ mime, data, thumb, name, size }).filter(([, v]) => v != null));
        }
        return out;
      };
      payload.attachments = { photos: await grab(photos, refs.photos), files: await grab(docs, refs.files) };
    }
    const blob = new Blob([JSON.stringify(payload, null, withAttachments ? 0 : 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `home-backup${withAttachments ? '-with-files' : ''}-${today()}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (missing) toast(`${missing} photo${missing === 1 ? '' : 's'}/file${missing === 1 ? '' : 's'} couldn’t be included: not on this device, and the data repo couldn’t be reached`, 'error');
  };
  return h('div', {},
    h('p', { class: 'muted' }, 'Download every record as one JSON file, or restore from one. “With photos & files” also packs in the pictures and uploaded documents (receipts, serial plates, manuals), so the file alone is a complete copy — it can be large.'),
    h('div', { class: 'field-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportJson(false) }, 'Download backup'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportJson(true) }, 'Download backup with photos & files'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => fileInput.click() }, 'Restore backup…')),
    fileInput);
}
