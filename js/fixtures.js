// Fixtures & loads, managed like rooms: a list you add to from any picker
// ("+ New fixture…"), rename, and delete. Breakers store fixtures by name
// ({ name, roomId }), so the list is the saved `fixtures` collection plus any
// name already used on a breaker; renaming rewrites those breakers, and
// deleting removes the fixture from them.

import { h, uid, input, textarea, field, select, openModal, confirmDialog, toast, byText, clear } from './ui.js';
import { FIXTURE_TIPS } from './tips.js';
import { store, saveRecord } from './sync.js';

// Offered until you add them; picking one adds it to your list.
export const COMMON_FIXTURES = ['Outlets', 'Lights', 'Ceiling fan', 'Refrigerator', 'Dishwasher', 'Disposal', 'Microwave',
  'Range / oven', 'Cooktop', 'Washer', 'Dryer', 'Water heater', 'Furnace', 'AC condenser', 'Heat pump', 'Sump pump',
  'Well pump', 'Garage door opener', 'Bathroom fan', 'Smoke detectors', 'EV charger', 'Hot tub', 'Subpanel'];

const key = (name) => String(name || '').trim().toLowerCase();
const breakers = () => store.get('breakers');

// Your fixtures: saved ones plus names already used on breakers, one per name.
export function fixtureList() {
  const byKey = new Map();
  for (const f of store.get('fixtures')) if (key(f.name)) byKey.set(key(f.name), { ...f });
  for (const b of breakers()) {
    for (const f of b.fixtures || []) {
      if (key(f.name) && !byKey.has(key(f.name))) byKey.set(key(f.name), { id: '', name: f.name.trim() });
    }
  }
  return [...byKey.values()].sort(byText((f) => f.name));
}

export const fixtureUsage = (name) => breakers().filter((b) => (b.fixtures || []).some((f) => key(f.name) === key(name))).length;

function findFixture(name) {
  return store.get('fixtures').find((f) => key(f.name) === key(name));
}

// Make sure a name is on the saved list (picking a common one adds it).
export async function ensureFixture(name) {
  const n = String(name || '').trim();
  if (!n || findFixture(n)) return;
  await saveRecord('fixtures', { id: uid(), name: n });
}

const NEW = '__new__';

// "+ Add fixture…" select: your fixtures, then common ones you haven't added,
// then "+ New fixture…". Calls onpick(name) and resets itself.
export function fixtureSelect({ onpick, exclude = () => false } = {}) {
  const el = select([], '', { 'aria-label': 'Add fixture' });
  const fill = () => {
    clear(el);
    el.append(h('option', { value: '' }, '+ Add fixture…'));
    const mine = fixtureList().filter((f) => !exclude(f.name));
    if (mine.length) el.append(h('optgroup', { label: 'Your fixtures' }, mine.map((f) => h('option', { value: f.name }, f.name))));
    const have = new Set(fixtureList().map((f) => key(f.name)));
    const common = COMMON_FIXTURES.filter((n) => !have.has(key(n)) && !exclude(n));
    if (common.length) el.append(h('optgroup', { label: 'Common' }, common.map((n) => h('option', { value: n }, n))));
    el.append(h('option', { value: NEW }, '+ New fixture…'));
    el.value = '';
  };
  fill();
  el.addEventListener('change', async () => {
    const v = el.value;
    el.value = '';
    if (!v) return;
    if (v === NEW) {
      const f = await editFixture();
      fill();
      if (f) onpick?.(f.name);
      return;
    }
    await ensureFixture(v);
    fill();
    onpick?.(v);
  });
  el.refill = fill;
  return el;
}

// Create (no arg) or edit a fixture by name. Resolves to { name } or null.
export function editFixture(name = '') {
  return new Promise((resolve) => {
    let saved = null;
    const existing = name ? findFixture(name) : null;
    const used = name ? fixtureUsage(name) : 0;
    const nameEl = input(name, { placeholder: 'e.g. Pendant lights, Garbage disposal' });
    const notes = textarea(existing?.notes || '', { placeholder: 'Optional: wattage, model, where exactly…' });
    const m = openModal({
      title: name ? `Edit fixture` : 'New fixture',
      tips: FIXTURE_TIPS,
      body: h('div', { class: 'form-grid' },
        field('Name', nameEl, { wide: true, hint: used ? `Used on ${used} breaker${used === 1 ? '' : 's'} — renaming updates them.` : '' }),
        field('Notes', notes, { wide: true })),
      onSave: async () => {
        const n = nameEl.value.trim();
        if (!n) { toast('Give the fixture a name', 'error'); return false; }
        const clash = fixtureList().find((f) => key(f.name) === key(n) && key(f.name) !== key(name));
        if (clash) { toast(`“${clash.name}” is already on your list`, 'error'); return false; }
        await saveRecord('fixtures', { ...(existing || { id: uid() }), name: n, notes: notes.value.trim() });
        if (name && n !== name) renameOnBreakers(name, n);
        saved = { name: n };
        return true;
      },
      onDelete: name ? async () => {
        const msg = used
          ? `Delete “${name}”? It will also be removed from ${used} breaker${used === 1 ? '' : 's'}.`
          : `Delete “${name}”?`;
        if (!(await confirmDialog(msg))) return false;
        if (existing) store.remove('fixtures', existing.id);
        if (used) removeFromBreakers(name);
        return true;
      } : null,
    });
    m.dialog.addEventListener('close', () => resolve(saved));
  });
}

function renameOnBreakers(from, to) {
  const k = key(from);
  if (!breakers().some((b) => (b.fixtures || []).some((f) => key(f.name) === k))) return;
  store.save('breakers', breakers().map((b) => (b.fixtures || []).some((f) => key(f.name) === k)
    ? { ...b, fixtures: dedupe(b.fixtures.map((f) => (key(f.name) === k ? { ...f, name: to } : f))) } : b));
}

function removeFromBreakers(name) {
  const k = key(name);
  store.save('breakers', breakers().map((b) => (b.fixtures || []).some((f) => key(f.name) === k)
    ? { ...b, fixtures: b.fixtures.filter((f) => key(f.name) !== k) } : b));
}

// Renaming "Lights" to an existing "Lighting" could leave a breaker with the
// same fixture twice in the same room; keep one.
const dedupe = (list) => list.filter((f, i) => list.findIndex((g) => key(g.name) === key(f.name) && g.roomId === f.roomId) === i);

// Fixture list for Settings.
export function fixturesManager() {
  const list = fixtureList();
  return h('div', {},
    list.length ? null : h('p', { class: 'muted' }, 'No fixtures yet. Add them here or from a breaker’s “Fixtures & loads”.'),
    ...list.map((f) => h('div', { class: 'list-row tappable', onclick: () => editFixture(f.name) },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, f.name),
        h('div', { class: 'row-sub' }, [`${fixtureUsage(f.name)} breaker${fixtureUsage(f.name) === 1 ? '' : 's'}`, f.notes].filter(Boolean).join(' · '))),
      h('span', { class: 'muted' }, 'Edit'))),
    h('div', { class: 'field-row', style: 'margin-top:10px' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => editFixture() }, '+ New fixture')));
}

