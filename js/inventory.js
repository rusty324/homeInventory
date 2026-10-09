// Home inventory: a sortable table of belongings — name, brand, model number,
// acquisition date, purchase cost, description, location, pictures, and
// manuals (links or uploaded files), and warranty expiry — with a running
// total and a CSV export for insurance paperwork. Warranties ending soon are
// also surfaced on the Maintenance tab (see warranty.js).

import {
  h, uid, input, textarea, field, select, setOptions, suggestInput, openModal, confirmDialog,
  toast, matches, byText, clear, emptyState, money, shortDate,
} from './ui.js';
import { ITEM_TIPS } from './tips.js';
import { store, saveRecord } from './sync.js';
import { rooms, roomName, roomSelect } from './rooms.js';
import { photoEditor, photoThumb, dropPhotos } from './photo-ui.js';
import { docsEditor, docLinks, dropDocs, docLabel } from './docs-ui.js';
import { warrantyStatus, warrantyPill, WARRANTY_SOON_DAYS } from './warranty.js';
import { today, addInterval } from './dates.js';

const COLUMNS = [
  { key: 'photo', label: '' },
  { key: 'name', label: 'Name' },
  { key: 'brand', label: 'Brand' },
  { key: 'model', label: 'Model #' },
  { key: 'acquiredOn', label: 'Acquired' },
  { key: 'cost', label: 'Cost', num: true },
  { key: 'warrantyUntil', label: 'Warranty' },
  { key: 'location', label: 'Location' },
  { key: 'description', label: 'Description' },
  { key: 'manuals', label: 'Manuals', numericSort: true },
];

const state = { q: '', room: '', warranty: '', sort: 'name', dir: 1 };
const WARRANTY_FILTERS = [
  ['', 'Any warranty'], ['covered', 'Under warranty'], ['soon', `Ending within ${WARRANTY_SOON_DAYS} days`],
  ['expired', 'Warranty ended'], ['none', 'No warranty date'],
];
const warrantyMatch = (i) => {
  const k = warrantyStatus(i).key;
  return !state.warranty || (state.warranty === 'covered' ? k === 'active' || k === 'soon' : k === state.warranty);
};

const items = () => store.get('items');
const locationText = (i) => [roomName(i.roomId), i.locationDetail].filter(Boolean).join(' — ');

function sortValue(i, key) {
  if (key === 'location') return locationText(i);
  if (key === 'cost') return i.cost === '' || i.cost == null ? null : Number(i.cost);
  if (key === 'manuals') return (i.manuals || []).length || null;
  return i[key] ?? '';
}

function filtered() {
  const { sort, dir } = state;
  const col = COLUMNS.find((c) => c.key === sort);
  return items()
    .filter((i) => (!state.room || i.roomId === state.room) && warrantyMatch(i)
      && matches(state.q, i.name, i.brand, i.model, i.serial, i.description, locationText(i), i.acquiredOn, i.warrantyNotes, (i.manuals || []).map(docLabel)))
    .sort((a, b) => {
      const va = sortValue(a, sort); const vb = sortValue(b, sort);
      // Blanks always sort last, whichever direction.
      const ea = va === '' || va == null; const eb = vb === '' || vb == null;
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return dir * (col?.num || col?.numericSort ? va - vb : byText((x) => x)(va, vb));
    });
}

let results;
let roomFilter;
let warrantyFilter;

export function mount(root) {
  results = h('div', { class: 'results' });
  const q = input(state.q, { type: 'search', placeholder: 'Search name, brand, model, serial…', 'aria-label': 'Search inventory' });
  q.addEventListener('input', () => { state.q = q.value; refresh(); });
  roomFilter = select([], state.room, { 'aria-label': 'Filter by location' });
  roomFilter.addEventListener('change', () => { state.room = roomFilter.value; refresh(); });
  warrantyFilter = select(WARRANTY_FILTERS, state.warranty, { 'aria-label': 'Filter by warranty' });
  warrantyFilter.addEventListener('change', () => { state.warranty = warrantyFilter.value; refresh(); });
  root.append(
    h('div', { class: 'toolbar' }, q, h('button', { class: 'btn', onclick: () => editItem() }, '+ Item')),
    h('div', { class: 'toolbar filters' }, roomFilter, warrantyFilter,
      h('button', { class: 'btn secondary', onclick: exportCsv }, 'Export CSV')),
    results);
  refresh();
}

export function refresh() {
  if (!results) return;
  setOptions(roomFilter, [['', 'All locations'], ...rooms().map((r) => [r.id, roomName(r.id)])], state.room);
  state.room = roomFilter.value;
  clear(results);
  if (!items().length) {
    results.append(emptyState('Record what you own — handy for insurance claims, warranties, and moving.',
      h('button', { class: 'btn', onclick: () => editItem() }, '+ Add your first item')));
    return;
  }
  const list = filtered();
  const total = list.reduce((s, i) => s + (Number(i.cost) || 0), 0);
  const showPhotos = list.some((i) => i.photoIds?.length);
  const head = h('tr', {}, COLUMNS.map((c) => {
    if (c.key === 'photo') return showPhotos ? h('th', { class: 'col-photo' }) : null;
    const on = state.sort === c.key;
    return h('th', { class: `${c.num ? 'num' : ''}${c.key === 'description' ? ' desc' : ''}`, 'aria-sort': on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', {
        type: 'button',
        class: `sort${on ? ' on' : ''}`,
        onclick: () => { if (on) state.dir = -state.dir; else { state.sort = c.key; state.dir = 1; } refresh(); },
      }, c.label, h('span', { class: 'sort-ind' }, on ? (state.dir > 0 ? ' ▲' : ' ▼') : '')));
  }));
  const body = h('tbody', {}, list.map((i) => h('tr', { class: 'tappable', onclick: () => editItem(i) },
    showPhotos ? h('td', { class: 'col-photo' }, i.photoIds?.[0] ? photoThumb(i.photoIds[0], { size: 'sm' }) : null) : null,
    h('td', { class: 'strong' }, i.name),
    h('td', {}, i.brand || ''),
    h('td', { class: 'mono' }, i.model || ''),
    h('td', { class: 'nowrap' }, shortDate(i.acquiredOn)),
    h('td', { class: 'num' }, money(i.cost)),
    h('td', { class: 'nowrap' }, warrantyPill(i)),
    h('td', {}, locationText(i)),
    h('td', { class: 'desc' }, i.description || ''),
    h('td', { class: 'col-docs' }, docLinks(i.manuals, { compact: true })))));
  results.append(
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', {}, head), body)),
    h('p', { class: 'muted totals' }, `${list.length} item${list.length === 1 ? '' : 's'}${list.length !== items().length ? ` (of ${items().length})` : ''} · total ${money(total) || '$0.00'}`));
}

export function editItem(item = null) {
  const it = item || { id: uid(), photoIds: [] };
  const name = input(it.name, { required: true, placeholder: 'e.g. Espresso machine' });
  const brands = [...new Set(items().map((x) => x.brand).filter(Boolean))].sort();
  const brand = suggestInput(it.brand, brands, {});
  const model = input(it.model, {});
  const serial = input(it.serial, {});
  const acquired = input(it.acquiredOn, { type: 'date' });
  const cost = input(it.cost, { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
  const room = roomSelect(it.roomId || '');
  const details = [...new Set(items().map((x) => x.locationDetail).filter(Boolean))].sort();
  const locationDetail = suggestInput(it.locationDetail, details, { placeholder: 'e.g. top shelf, left closet' });
  const description = textarea(it.description);
  const pics = photoEditor(it.photoIds || []);
  const manuals = docsEditor(it.manuals || []);
  const warrantyUntil = input(it.warrantyUntil, { type: 'date', 'aria-label': 'Warranty expires' });
  const warrantyNotes = input(it.warrantyNotes, { placeholder: 'Provider, plan or registration #, claim phone…' });
  // Quick fill: N years from the acquisition date (or today if there isn't one).
  const quick = h('div', { class: 'quick-row' },
    [1, 2, 3, 5].map((n) => h('button', {
      type: 'button',
      class: 'btn small secondary',
      title: `${n} year${n === 1 ? '' : 's'} from the acquisition date`,
      onclick: () => { warrantyUntil.value = addInterval(acquired.value || today(), n, 'years'); },
    }, `+${n} yr`)),
    h('button', { type: 'button', class: 'btn small secondary', onclick: () => { warrantyUntil.value = ''; } }, 'Clear'));

  openModal({
    title: item ? 'Edit item' : 'New item',
    tips: ITEM_TIPS,
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Name', name, { wide: true }),
      field('Brand', brand),
      field('Model number', model),
      field('Serial number', serial),
      field('Acquisition date', acquired),
      field('Purchase cost ($)', cost),
      field('Room', room),
      field('Location detail', locationDetail),
      field('Description', description, { wide: true }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Warranty expires'), warrantyUntil, quick),
      field('Warranty details', warrantyNotes, { hint: `Reminders appear under Maintenance ${WARRANTY_SOON_DAYS} days ahead` }),
      field('Pictures (item, receipt, serial plate)', pics.el, { wide: true }),
      field('Manuals & documents', manuals.el, { wide: true })),
    onSave: async () => {
      if (!name.value.trim()) { toast('Give the item a name', 'error'); return false; }
      const photoIds = await pics.commit();
      const manualList = await manuals.commit();
      saveRecord('items', {
        ...it,
        name: name.value.trim(),
        brand: brand.input.value.trim(),
        model: model.value.trim(),
        serial: serial.value.trim(),
        acquiredOn: acquired.value,
        cost: cost.value === '' ? '' : Math.round(Number(cost.value) * 100) / 100,
        roomId: room.value,
        locationDetail: locationDetail.input.value.trim(),
        description: description.value.trim(),
        warrantyUntil: warrantyUntil.value,
        warrantyNotes: warrantyNotes.value.trim(),
        photoIds,
        manuals: manualList,
      });
      return true;
    },
    onDelete: item ? async () => {
      if (!(await confirmDialog(`Delete “${item.name}”?`))) return false;
      store.remove('items', item.id);
      dropPhotos(item.photoIds);
      dropDocs(item.manuals);
      return true;
    } : null,
  });
}

function exportCsv() {
  const cols = ['Name', 'Brand', 'Model', 'Serial', 'Acquired', 'Cost', 'Warranty until', 'Warranty details', 'Room', 'Location detail', 'Description', 'Photos', 'Manuals'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const rows = filtered().map((i) => [i.name, i.brand, i.model, i.serial, i.acquiredOn, i.cost, i.warrantyUntil, i.warrantyNotes, roomName(i.roomId), i.locationDetail, i.description, (i.photoIds || []).length,
    (i.manuals || []).map((d) => (d.kind === 'link' ? d.url : `${docLabel(d)} (uploaded file)`)).join(' | ')]);
  const csv = [cols, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `home-inventory-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
