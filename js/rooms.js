// Rooms are shared by all three tools: paint is applied in rooms, breakers
// feed rooms, inventory items live in rooms. One collection, many pickers.

import { h, uid, input, textarea, field, select, setOptions, suggestInput, openModal, confirmDialog, toast, byText, clear } from './ui.js';
import { store, saveRecord } from './sync.js';

export const rooms = () => store.get('rooms').slice().sort((a, b) =>
  byText((r) => r.property)(a, b) || byText((r) => r.name)(a, b));

export function roomById(id) {
  return store.get('rooms').find((r) => r.id === id);
}

// Display name; property is shown only when there's more than one property.
export function roomName(id) {
  const r = roomById(id);
  if (!r) return id ? '(deleted room)' : '';
  return multiProperty() && r.property ? `${r.name} · ${r.property}` : r.name;
}

export const properties = () => [...new Set([
  ...store.get('rooms').map((r) => r.property),
  ...store.get('panels').map((p) => p.property),
].filter(Boolean))].sort();

const multiProperty = () => properties().length > 1;

export function roomOptions(noneLabel = '— none —') {
  return [['', noneLabel], ...rooms().map((r) => [r.id, roomName(r.id)])];
}

const NEW = '__new__';

// <select> of rooms with a trailing "+ New room…" that creates one inline.
export function roomSelect(value = '', { noneLabel = '— none —', onchange } = {}) {
  const el = select([], value);
  const fill = (v) => setOptions(el, [...roomOptions(noneLabel), [NEW, '+ New room…']], v);
  fill(value);
  let prev = el.value;
  el.addEventListener('change', async () => {
    if (el.value !== NEW) { prev = el.value; onchange?.(el.value); return; }
    const r = await editRoom();
    fill(r ? r.id : prev);
    prev = el.value;
    onchange?.(el.value);
  });
  return el;
}

// Chip list of rooms with an add-select. -> { el, value(): string[] }
export function roomMultiPicker(ids = []) {
  let selected = [...ids];
  const chips = h('div', { class: 'chips' });
  const picker = roomSelect('', { noneLabel: '+ Add room…', onchange: (v) => {
    if (v && !selected.includes(v)) selected.push(v);
    picker.value = '';
    render();
  } });
  function render() {
    clear(chips);
    for (const id of selected) {
      chips.appendChild(h('span', { class: 'chip' }, roomName(id),
        h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { selected = selected.filter((s) => s !== id); render(); } }, '✕')));
    }
    chips.appendChild(picker);
  }
  render();
  return { el: chips, value: () => [...selected] };
}

// Create (no arg) or edit a room. Resolves to the saved room, or null.
export function editRoom(room = null) {
  return new Promise((resolve) => {
    let saved = null;
    const name = input(room?.name, { required: true, placeholder: 'e.g. Kitchen' });
    const property = suggestInput(room?.property, properties(), { placeholder: 'e.g. Main house' });
    const floor = suggestInput(room?.floor, ['Basement', 'Main floor', 'Upstairs', 'Attic', 'Garage', 'Exterior'], {});
    const notes = textarea(room?.notes);
    const m = openModal({
      title: room ? 'Edit room' : 'New room',
      body: h('div', { class: 'form-grid' },
        field('Name', name),
        field('Property', property, { hint: 'Optional — only needed with more than one property' }),
        field('Floor / area', floor),
        field('Notes', notes, { wide: true })),
      onSave: async () => {
        if (!name.value.trim()) { toast('Give the room a name', 'error'); return false; }
        saved = await saveRecord('rooms', {
          ...(room || { id: uid() }),
          name: name.value.trim(),
          property: property.input.value.trim(),
          floor: floor.input.value.trim(),
          notes: notes.value.trim(),
        });
        return true;
      },
      onDelete: room ? async () => {
        const uses = roomUsage(room.id);
        const msg = uses ? `“${room.name}” is used by ${uses} record(s); they'll show it as a deleted room. Delete anyway?` : `Delete “${room.name}”?`;
        if (!(await confirmDialog(msg))) return false;
        store.remove('rooms', room.id);
        return true;
      } : null,
    });
    m.dialog.addEventListener('close', () => resolve(saved));
  });
}

export function roomUsage(id) {
  return store.get('paints').filter((p) => (p.uses || []).some((u) => u.roomId === id)).length
    + store.get('breakers').filter((b) => (b.roomIds || []).includes(id)).length
    + store.get('items').filter((i) => i.roomId === id).length;
}

// Room list for Settings.
export function roomsManager() {
  const list = rooms();
  return h('div', {},
    list.length ? null : h('p', { class: 'muted' }, 'No rooms yet. Rooms are shared by the paint log, breakers, and inventory.'),
    ...list.map((r) => h('div', { class: 'list-row tappable', onclick: () => editRoom(r) },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, r.name),
        h('div', { class: 'row-sub' }, [r.property, r.floor, `${roomUsage(r.id)} linked`].filter(Boolean).join(' · '))),
      h('span', { class: 'muted' }, 'Edit'))),
    h('div', { class: 'field-row', style: 'margin-top:10px' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => editRoom() }, '+ New room')));
}
