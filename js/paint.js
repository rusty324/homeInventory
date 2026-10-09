// Paint logger: colors with brand/code/sheen/base, assigned to one or more
// rooms (each with an area like "Walls" or "Trim"), with photos of swatches
// and can labels. Searchable by room, color name, color family, and brand.

import {
  h, uid, input, textarea, field, select, setOptions, suggestInput, openModal, confirmDialog,
  toast, matches, byText, clear, emptyState, segmented, shortDate,
} from './ui.js';
import { PAINT_TIPS } from './tips.js';
import { store, saveRecord } from './sync.js';
import { rooms, roomName, roomSelect, editRoom } from './rooms.js';
import { photoEditor, photoThumb, dropPhotos } from './photo-ui.js';

export const FAMILIES = ['Whites', 'Neutrals', 'Grays', 'Blacks', 'Browns', 'Reds', 'Pinks', 'Oranges', 'Yellows', 'Greens', 'Blues', 'Purples'];
const SHEENS = ['Flat / Matte', 'Eggshell', 'Satin', 'Semi-gloss', 'Gloss', 'High-gloss'];
const MEDIUMS = ['Water-based (latex/acrylic)', 'Oil-based (alkyd)', 'Water-based alkyd', 'Primer', 'Stain'];
const TINT_BASES = ['Pastel / Base 1', 'Medium / Base 2', 'Deep / Base 3', 'Ultra deep / Base 4', 'White base', 'Neutral base', 'Accent base'];
const AREAS = ['Walls', 'Ceiling', 'Trim', 'Doors', 'Accent wall', 'Cabinets', 'Baseboards', 'Windows', 'Exterior siding', 'Exterior trim'];
const BRANDS = ['Sherwin-Williams', 'Benjamin Moore', 'Behr', 'PPG', 'Valspar', 'Farrow & Ball', 'Glidden', 'Dunn-Edwards', 'Clark+Kensington', 'Kilz'];

// Rough hue/lightness bucket for a hex swatch — a suggestion the user can override.
export function familyOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  if (hue < 0) hue += 360;
  if (l > 0.9) return 'Whites';
  if (l < 0.2) return 'Blacks';
  if (s < 0.1) return 'Grays';
  if (s < 0.3 && hue >= 20 && hue <= 60) return l > 0.55 ? 'Neutrals' : 'Browns';
  if (hue < 15 || hue >= 345) return l > 0.7 ? 'Pinks' : 'Reds';
  if (hue < 40) return l < 0.4 ? 'Browns' : 'Oranges';
  if (hue < 65) return l < 0.35 ? 'Browns' : 'Yellows';
  if (hue < 170) return 'Greens';
  if (hue < 255) return 'Blues';
  if (hue < 300) return 'Purples';
  return 'Pinks';
}

const state = { q: '', room: '', family: '', brand: '', view: 'colors' };

const paints = () => store.get('paints');
const familyFor = (p) => p.family || familyOf(p.hex);
const usesText = (p) => (p.uses || []).map((u) => `${roomName(u.roomId)} ${u.area || ''}`);

function filtered() {
  return paints().filter((p) =>
    (!state.room || (p.uses || []).some((u) => u.roomId === state.room))
    && (!state.family || familyFor(p) === state.family)
    && (!state.brand || p.brand === state.brand)
    && matches(state.q, p.colorName, p.colorCode, p.brand, p.productLine, familyFor(p), p.sheen, p.notes, usesText(p)))
    .sort(byText((p) => p.colorName));
}

function swatch(p, cls = 'swatch') {
  return h('span', { class: `${cls}${p.hex ? '' : ' none'}`, style: p.hex ? `background:${p.hex}` : '', title: p.hex || 'no swatch color' });
}

// ---------- tab ----------

let results;
let filterEls;

export function mount(root) {
  results = h('div', { class: 'results' });
  const q = input(state.q, { type: 'search', placeholder: 'Search color, code, brand, room…', 'aria-label': 'Search paints' });
  q.addEventListener('input', () => { state.q = q.value; refresh(); });
  filterEls = {
    room: select([], state.room, { 'aria-label': 'Filter by room' }),
    family: select([], state.family, { 'aria-label': 'Filter by color family' }),
    brand: select([], state.brand, { 'aria-label': 'Filter by brand' }),
  };
  for (const [k, el] of Object.entries(filterEls)) el.addEventListener('change', () => { state[k] = el.value; refresh(); });

  root.append(
    h('div', { class: 'toolbar' },
      q,
      h('button', { class: 'btn', onclick: () => editPaint() }, '+ Paint'),
    ),
    h('div', { class: 'toolbar filters' },
      filterEls.room, filterEls.family, filterEls.brand,
      segmented([{ value: 'colors', label: 'Colors' }, { value: 'rooms', label: 'By room' }], state.view, (v) => { state.view = v; refresh(); }),
    ),
    results);
  refresh();
}

export function refresh() {
  if (!results) return;
  setOptions(filterEls.room, [['', 'All rooms'], ...rooms().map((r) => [r.id, roomName(r.id)])], state.room);
  setOptions(filterEls.family, [['', 'All families'], ...FAMILIES], state.family);
  const brands = [...new Set(paints().map((p) => p.brand).filter(Boolean))].sort();
  setOptions(filterEls.brand, [['', 'All brands'], ...brands], state.brand);
  for (const k of Object.keys(filterEls)) state[k] = filterEls[k].value;

  clear(results);
  const list = filtered();
  if (!paints().length && !rooms().length) {
    results.append(emptyState('Log the paint in each room so touch-ups never mean guessing again.',
      h('div', { class: 'field-row' },
        h('button', { class: 'btn', onclick: () => editPaint() }, '+ Add your first paint'),
        h('button', { class: 'btn secondary', onclick: () => editRoom() }, '+ Add a room'))));
    return;
  }
  if (state.view === 'rooms') renderByRoom(list);
  else renderColors(list);
}

function renderColors(list) {
  if (!list.length) { results.append(emptyState('No paints match.')); return; }
  results.append(h('div', { class: 'card-grid' }, list.map((p) =>
    h('article', { class: 'card paint-card tappable', onclick: () => editPaint(p) },
      swatch(p, 'swatch big'),
      h('div', { class: 'card-body' },
        h('div', { class: 'row-title' }, p.colorName || '(unnamed color)'),
        h('div', { class: 'row-sub' }, [p.brand, p.colorCode].filter(Boolean).join(' · ')),
        h('div', { class: 'row-sub' }, [p.sheen, familyFor(p)].filter(Boolean).join(' · ')),
        (p.uses || []).length ? h('div', { class: 'chips small' }, p.uses.map((u) =>
          h('span', { class: 'chip' }, roomName(u.roomId) + (u.area ? ` — ${u.area}` : '')))) : null,
        (p.photoIds || []).length ? h('div', { class: 'thumb-row' }, p.photoIds.slice(0, 3).map((id) => photoThumb(id))) : null)))));
}

function renderByRoom(list) {
  const shown = rooms().filter((r) => !state.room || r.id === state.room);
  const filtering = state.q || state.family || state.brand;
  const sections = [];
  for (const r of shown) {
    const entries = [];
    for (const p of list) for (const u of p.uses || []) if (u.roomId === r.id) entries.push({ p, u });
    if (filtering && !entries.length) continue;
    entries.sort(byText((e) => e.u.area));
    sections.push(h('section', { class: 'room-block' },
      h('header', { class: 'room-head' },
        h('h3', {}, roomName(r.id)),
        h('span', { class: 'muted' }, r.floor || ''),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small secondary', onclick: () => editPaint(null, r.id) }, '+ Paint'),
        h('button', { class: 'btn small secondary', onclick: () => editRoom(r) }, 'Edit')),
      entries.length
        ? entries.map(({ p, u }) => h('div', { class: 'list-row tappable', onclick: () => editPaint(p) },
            swatch(p),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, `${u.area || 'Unspecified area'}: ${p.colorName || '(unnamed)'}`),
              h('div', { class: 'row-sub' }, [p.brand, p.colorCode, p.sheen, u.coats ? `${u.coats} coats` : '', u.date ? shortDate(u.date) : ''].filter(Boolean).join(' · ')))))
        : h('p', { class: 'muted' }, 'No paint logged here yet.')));
  }
  const orphans = state.room ? [] : list.filter((p) => !(p.uses || []).length);
  if (orphans.length) {
    sections.push(h('section', { class: 'room-block' },
      h('header', { class: 'room-head' }, h('h3', {}, 'Not assigned to a room')),
      orphans.map((p) => h('div', { class: 'list-row tappable', onclick: () => editPaint(p) }, swatch(p),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.colorName || '(unnamed)'),
          h('div', { class: 'row-sub' }, [p.brand, p.colorCode].filter(Boolean).join(' · ')))))));
  }
  results.append(sections.length ? h('div', {}, sections) : emptyState('No rooms match.'),
    h('div', { class: 'field-row' }, h('button', { class: 'btn secondary', onclick: () => editRoom() }, '+ Add room')));
}

// ---------- editor ----------

// Room/area assignment rows. -> { el, value() }
function usesEditor(uses) {
  const rows = [];
  const box = h('div', { class: 'uses' });
  const addBtn = h('button', { type: 'button', class: 'btn small secondary', onclick: () => { addRow({}); } }, '+ Assign to a room');
  function addRow(u) {
    const roomEl = roomSelect(u.roomId || '', { noneLabel: '— choose room —' });
    const area = suggestInput(u.area, AREAS, { placeholder: 'Area (walls, trim…)', 'aria-label': 'Area' });
    const coats = input(u.coats, { type: 'number', min: 0, step: 1, placeholder: 'Coats', 'aria-label': 'Coats', class: 'narrow' });
    const date = input(u.date, { type: 'date', 'aria-label': 'Date painted' });
    const row = { roomEl, area, coats, date };
    row.el = h('div', { class: 'use-row' }, roomEl, area, coats, date,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove assignment', onclick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); } }, '✕'));
    rows.push(row);
    box.insertBefore(row.el, addBtn);
  }
  box.append(addBtn);
  for (const u of uses) addRow(u);
  if (!uses.length) addRow({});
  return {
    el: box,
    value: () => rows.filter((r) => r.roomEl.value).map((r) => ({
      roomId: r.roomEl.value,
      area: r.area.input.value.trim(),
      coats: r.coats.value ? Number(r.coats.value) : '',
      date: r.date.value,
    })),
  };
}

export function editPaint(paint = null, presetRoomId = '') {
  const p = paint || { id: uid(), uses: presetRoomId ? [{ roomId: presetRoomId, area: '' }] : [], photoIds: [] };
  const colorName = input(p.colorName, { placeholder: 'e.g. Agreeable Gray' });
  const colorCode = input(p.colorCode, { placeholder: 'e.g. SW 7029' });
  const brandSuggestions = [...new Set([...paints().map((x) => x.brand), ...BRANDS])];
  const brand = suggestInput(p.brand, brandSuggestions, { placeholder: 'Brand' });
  const productLine = input(p.productLine, { placeholder: 'e.g. Duration, Regal Select' });
  const hex = input(p.hex || '#d9d4cc', { type: 'color', 'aria-label': 'Swatch color' });
  const noHex = h('input', { type: 'checkbox' });
  noHex.checked = !p.hex && !!paint;
  const family = select([['', 'Auto (from swatch)'], ...FAMILIES], p.family || '');
  const famHint = h('span', { class: 'field-hint' });
  const updateHint = () => { famHint.textContent = !noHex.checked ? `Swatch suggests: ${familyOf(hex.value) || '—'}` : ''; };
  hex.addEventListener('input', updateHint);
  noHex.addEventListener('change', updateHint);
  updateHint();
  const sheen = select([['', '—'], ...SHEENS], p.sheen || '');
  const medium = select([['', '—'], ...MEDIUMS], p.medium || '');
  const tintBase = suggestInput(p.tintBase, TINT_BASES, { placeholder: 'e.g. Base 2' });
  const coverage = input(p.coverage, { placeholder: 'e.g. 1 gal ≈ 350 sq ft, 2 coats' });
  const purchased = input(p.purchasedFrom, { placeholder: 'Store, date, quantity left…' });
  const notes = textarea(p.notes, { placeholder: 'Coverage, number of coats, prep, anything else' });
  const uses = usesEditor(p.uses || []);
  const pics = photoEditor(p.photoIds || []);

  openModal({
    title: paint ? 'Edit paint' : 'New paint',
    tips: PAINT_TIPS,
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Color name', colorName),
      field('Color code', colorCode),
      field('Brand', brand),
      field('Product line', productLine),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Swatch'),
        h('div', { class: 'swatch-pick' }, hex, h('label', { class: 'inline' }, noHex, ' No swatch'))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color family'), family, famHint),
      field('Sheen', sheen),
      field('Base type', medium),
      field('Tint base', tintBase),
      field('Coverage', coverage),
      field('Rooms & areas', uses.el, { wide: true }),
      field('Photos (swatches, can labels)', pics.el, { wide: true }),
      field('Purchased / leftovers', purchased, { wide: true }),
      field('Notes', notes, { wide: true })),
    onSave: async () => {
      const usesVal = uses.value();
      if (!colorName.value.trim() && !colorCode.value.trim()) {
        toast('Enter a color name or code', 'error');
        return false;
      }
      const photoIds = await pics.commit();
      saveRecord('paints', {
        ...p,
        colorName: colorName.value.trim(),
        colorCode: colorCode.value.trim(),
        brand: brand.input.value.trim(),
        productLine: productLine.value.trim(),
        hex: noHex.checked ? '' : hex.value,
        family: family.value,
        sheen: sheen.value,
        medium: medium.value,
        tintBase: tintBase.input.value.trim(),
        coverage: coverage.value.trim(),
        purchasedFrom: purchased.value.trim(),
        notes: notes.value.trim(),
        uses: usesVal,
        photoIds,
      });
      return true;
    },
    onDelete: paint ? async () => {
      if (!(await confirmDialog(`Delete “${paint.colorName || paint.colorCode}”?`))) return false;
      store.remove('paints', paint.id);
      dropPhotos(paint.photoIds);
      return true;
    } : null,
  });
}

