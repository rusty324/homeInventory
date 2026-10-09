// Breaker library: panels (main and sub, across properties) and the breakers
// in them. Standard North American layout: odd slots on the left, even on the
// right, one row per pair. A multi-pole breaker at slot s also occupies s+2
// (and s+4); tandems share a slot as halves A/B. Phase legs alternate by row.
//
// The printable legend uses the browser's print dialog ("Save as PDF") with
// an @page size set to the chosen paper, so there's no PDF library to vendor.

import {
  h, uid, input, textarea, field, select, setOptions, suggestInput, openModal, confirmDialog,
  toast, matches, byText, clear, emptyState, segmented,
} from './ui.js';
import { store, saveRecord } from './sync.js';
import { rooms, roomName, roomMultiPicker, properties } from './rooms.js';

const TYPES = ['Standard', 'GFCI', 'AFCI', 'Dual function (AFCI/GFCI)', 'HACR', 'Main', 'Spare', 'Surge protector'];
const TYPE_BADGE = { GFCI: 'GFCI', AFCI: 'AFCI', 'Dual function (AFCI/GFCI)': 'DF', HACR: 'HACR', Main: 'MAIN', Spare: 'SPARE', 'Surge protector': 'SPD' };
const AMPS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200];
const GAUGES = ['14 AWG', '12 AWG', '10 AWG', '8 AWG', '6 AWG', '4 AWG', '3 AWG', '2 AWG', '1 AWG', '1/0 AWG', '2/0 AWG', '3/0 AWG', '4/0 AWG'];
const WIRE_TYPES = ['NM-B (Romex)', 'UF-B', 'THHN/THWN in conduit', 'MC cable', 'AC (BX)', 'SER', 'Aluminum SER', 'XHHW'];
const FIXTURES = ['Outlets', 'Lights', 'Ceiling fan', 'Refrigerator', 'Dishwasher', 'Disposal', 'Microwave', 'Range / oven', 'Cooktop', 'Washer', 'Dryer', 'Water heater', 'Furnace', 'AC condenser', 'Heat pump', 'Sump pump', 'Well pump', 'Garage door opener', 'Bathroom fan', 'Smoke detectors', 'EV charger', 'Hot tub', 'Subpanel'];
const DEFAULT_PHASE = ['#1f2937', '#dc2626', '#2563eb'];
const VOLTAGES = ['120/240V split-phase', '120/208V three-phase', '277/480V three-phase', '120V'];

const state = { panelId: '', view: 'panel', q: '' };

const panels = () => store.get('panels').slice().sort((a, b) => byText((p) => p.property)(a, b) || byText((p) => p.kind === 'main' ? 0 : 1)(a, b) || byText((p) => p.name)(a, b));
const panelById = (id) => store.get('panels').find((p) => p.id === id);
const breakersIn = (panelId) => store.get('breakers').filter((b) => b.panelId === panelId);
const panelLabel = (p) => (p ? (properties().length > 1 && p.property ? `${p.name} · ${p.property}` : p.name) : '(deleted panel)');

const rowsOf = (panel) => Math.ceil((Number(panel.spaces) || 40) / 2);
const rowOfSlot = (slot) => Math.ceil(slot / 2);
const legs = (panel) => Math.min(3, Math.max(1, Number(panel.legs) || 2));
const phaseColor = (panel, row) => (panel.phaseColors || DEFAULT_PHASE)[legs(panel) === 1 ? 0 : (row - 1) % legs(panel)] || DEFAULT_PHASE[0];
const slotsOf = (b) => Array.from({ length: Number(b.poles) || 1 }, (_, i) => Number(b.slot) + 2 * i);

function breakerTitle(b) {
  return b.label || (b.type === 'Spare' ? 'Spare' : (b.fixtures || []).join(', ') || roomsText(b) || 'Unlabeled');
}
const roomsText = (b) => (b.roomIds || []).map(roomName).join(', ');
const slotText = (b) => {
  const s = slotsOf(b);
  return (s.length > 1 ? `${s[0]}/${s.slice(1).join('/')}` : `${s[0]}`) + (b.half || '');
};
const ratingText = (b) => [b.amps ? `${b.amps}A` : '', (Number(b.poles) || 1) > 1 ? `${b.poles}P` : ''].filter(Boolean).join(' ');

function searchHit(b) {
  const fed = panelById(b.feedsPanelId);
  return matches(state.q, b.label, b.type, b.notes, b.wireGauge, b.fixtures, roomsText(b), slotText(b), b.amps ? `${b.amps}a` : '', fed?.name);
}

// Lay out a panel: for each side, which group of breakers starts at which row
// and how many rows it spans. Breakers that collide or fall off the panel
// come back in `conflicts` so they're never silently hidden.
function layout(panel) {
  const R = rowsOf(panel);
  const groups = new Map();
  for (const b of breakersIn(panel.id)) {
    const s = Number(b.slot);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(b);
  }
  const placed = []; // { side: 0|1, row, span, slot, items }
  const covered = new Set();
  const conflicts = [];
  for (const [slot, items] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rowOfSlot(slot);
    const span = Math.max(...items.map((b) => Number(b.poles) || 1));
    if (!(slot >= 1) || row > R || covered.has(slot)) { conflicts.push(...items); continue; }
    const cells = Array.from({ length: span }, (_, i) => slot + 2 * i).filter((s) => rowOfSlot(s) <= R);
    if (cells.some((s) => covered.has(s) || (s !== slot && groups.has(s)))) {
      // Overlaps a later-starting group; place what fits, flag the rest.
      const fit = [slot];
      for (const s of cells.slice(1)) { if (covered.has(s) || groups.has(s)) break; fit.push(s); }
      fit.forEach((s) => covered.add(s));
      placed.push({ side: slot % 2 ? 0 : 1, row, span: fit.length, slot, items });
      if (fit.length < span) conflicts.push(...items.filter((b) => (Number(b.poles) || 1) > fit.length));
      continue;
    }
    cells.forEach((s) => covered.add(s));
    placed.push({ side: slot % 2 ? 0 : 1, row, span: cells.length, slot, items: items.sort(byText((b) => b.half)) });
  }
  return { R, placed, covered, conflicts };
}

// ---------- tab ----------

let results;
let panelSel;

export function mount(root) {
  results = h('div', { class: 'results' });
  panelSel = select([], state.panelId, { 'aria-label': 'Panel' });
  panelSel.addEventListener('change', () => { state.panelId = panelSel.value; refresh(); });
  const q = input(state.q, { type: 'search', placeholder: 'Find a breaker: room, fixture, label…', 'aria-label': 'Search breakers' });
  q.addEventListener('input', () => { state.q = q.value; refresh(); });
  root.append(
    h('div', { class: 'toolbar' },
      q,
      h('button', { class: 'btn', onclick: () => editBreaker() }, '+ Breaker')),
    h('div', { class: 'toolbar filters' },
      panelSel,
      h('button', { class: 'btn secondary', onclick: () => editPanel() }, '+ Panel'),
      segmented([{ value: 'panel', label: 'Panel' }, { value: 'list', label: 'List' }, { value: 'rooms', label: 'By room' }],
        state.view, (v) => { state.view = v; refresh(); })),
    results);
  refresh();
}

export function refresh() {
  if (!results) return;
  const ps = panels();
  if (!ps.find((p) => p.id === state.panelId)) state.panelId = ps[0]?.id || '';
  setOptions(panelSel, ps.length ? ps.map((p) => [p.id, panelLabel(p)]) : [['', 'No panels yet']], state.panelId);
  panelSel.disabled = !ps.length;
  clear(results);
  if (!ps.length) {
    results.append(emptyState('Add your electrical panel, then map each breaker to the rooms and fixtures it controls.',
      h('button', { class: 'btn', onclick: () => editPanel() }, '+ Add a panel')));
    return;
  }
  if (state.view === 'list') renderList();
  else if (state.view === 'rooms') renderRooms();
  else renderPanel(panelById(state.panelId));
}

function panelHeader(panel) {
  const feeder = store.get('breakers').find((b) => b.feedsPanelId === panel.id);
  const fedFrom = feeder ? panelById(feeder.panelId) : null;
  const n = breakersIn(panel.id).length;
  return h('div', { class: 'panel-head' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, panel.name, panel.kind === 'sub' ? h('span', { class: 'badge' }, 'SUB') : null),
      h('div', { class: 'row-sub' }, [
        panel.property, panel.location,
        panel.mainAmps ? `${panel.mainAmps}A main` : '',
        panel.voltage, `${panel.spaces || 40} spaces`, `${n} breaker${n === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ')),
      fedFrom ? h('div', { class: 'row-sub' }, 'Fed from ',
        h('a', { href: '#breakers', onclick: (e) => { e.preventDefault(); state.panelId = fedFrom.id; refresh(); } }, `${fedFrom.name}, slot ${slotText(feeder)}`)) : null),
    h('div', { class: 'phase-key' }, Array.from({ length: legs(panel) }, (_, i) =>
      h('span', { class: 'phase-dot', style: `--c:${(panel.phaseColors || DEFAULT_PHASE)[i]}` }, `L${i + 1}`))),
    h('button', { class: 'btn small secondary', onclick: () => editPanel(panel) }, 'Edit panel'),
    h('button', { class: 'btn small secondary', onclick: () => printLegend(panel) }, 'Print legend'));
}

function breakerCell(b, panel) {
  const badge = TYPE_BADGE[b.type];
  const fed = panelById(b.feedsPanelId);
  return h('div', { class: `brk${state.q && !searchHit(b) ? ' dim' : ''}${state.q && searchHit(b) ? ' hit' : ''}`, onclick: (e) => { e.stopPropagation(); editBreaker(b, panel.id); } },
    h('div', { class: 'brk-top' },
      b.half ? h('span', { class: 'badge' }, b.half) : null,
      h('span', { class: 'brk-rating' }, ratingText(b)),
      badge ? h('span', { class: `badge t-${badge.toLowerCase()}` }, badge) : null),
    h('div', { class: 'brk-label' }, breakerTitle(b)),
    roomsText(b) && b.label ? h('div', { class: 'brk-sub' }, roomsText(b)) : null,
    fed ? h('a', { class: 'brk-sub', href: '#breakers', onclick: (e) => { e.preventDefault(); e.stopPropagation(); state.panelId = fed.id; refresh(); } }, `→ ${fed.name}`) : null);
}

function renderPanel(panel) {
  const { R, placed, covered, conflicts } = layout(panel);
  const grid = h('div', { class: 'panel-grid', style: `grid-template-rows: repeat(${R}, minmax(3.2em, auto))` });
  for (let r = 1; r <= R; r++) {
    const c = phaseColor(panel, r);
    grid.append(
      h('div', { class: 'slot-num left', style: `grid-row:${r};grid-column:1;--c:${c}` }, String(2 * r - 1)),
      h('div', { class: 'slot-num right', style: `grid-row:${r};grid-column:4;--c:${c}` }, String(2 * r)));
    for (const side of [0, 1]) {
      const slot = 2 * r - (side ? 0 : 1);
      if (covered.has(slot)) continue;
      grid.append(h('button', {
        class: 'slot-empty',
        style: `grid-row:${r};grid-column:${side + 2}`,
        'aria-label': `Add breaker in slot ${slot}`,
        onclick: () => editBreaker(null, panel.id, slot),
      }, '+'));
    }
  }
  for (const g of placed) {
    grid.append(h('div', {
      class: `slot-fill${g.items.length > 1 ? ' tandem' : ''}${g.span > 1 ? ' multi' : ''}`,
      style: `grid-row:${g.row} / span ${g.span};grid-column:${g.side + 2}`,
    }, g.items.map((b) => breakerCell(b, panel))));
  }
  results.append(panelHeader(panel), h('div', { class: 'panel-wrap' }, grid));
  if (conflicts.length) {
    results.append(h('section', { class: 'room-block warn' },
      h('h3', {}, 'Overlapping or out-of-range breakers'),
      h('p', { class: 'muted' }, 'These collide with another breaker or sit past the last space. Edit their slot or poles.'),
      conflicts.map((b) => listRow(b))));
  }
}

function listRow(b, showPanel = false) {
  const p = panelById(b.panelId);
  return h('div', { class: 'list-row tappable', onclick: () => editBreaker(b) },
    h('span', { class: 'slot-pill', style: p ? `--c:${phaseColor(p, rowOfSlot(Number(b.slot)))}` : '' }, slotText(b)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, breakerTitle(b)),
      h('div', { class: 'row-sub' }, [showPanel ? panelLabel(p) : '', ratingText(b), b.type !== 'Standard' ? b.type : '', b.wireGauge, roomsText(b), (b.fixtures || []).join(', ')].filter(Boolean).join(' · '))));
}

function renderList() {
  const all = state.q ? store.get('breakers') : breakersIn(state.panelId);
  const list = all.filter(searchHit).sort((a, b) => byText((x) => panelLabel(panelById(x.panelId)))(a, b) || Number(a.slot) - Number(b.slot) || byText((x) => x.half)(a, b));
  if (!state.q) results.append(panelHeader(panelById(state.panelId)));
  else results.append(h('p', { class: 'muted' }, `Searching all panels — ${list.length} match${list.length === 1 ? '' : 'es'}`));
  results.append(list.length ? h('div', { class: 'card flat' }, list.map((b) => listRow(b, !!state.q))) : emptyState('No breakers match.'));
}

function renderRooms() {
  const all = store.get('breakers').filter(searchHit);
  const sections = [];
  for (const r of rooms()) {
    const bs = all.filter((b) => (b.roomIds || []).includes(r.id));
    if (!bs.length) continue;
    sections.push(h('section', { class: 'room-block' }, h('header', { class: 'room-head' }, h('h3', {}, roomName(r.id))),
      bs.sort(byText((b) => `${panelById(b.panelId)?.name} ${String(b.slot).padStart(3, '0')}`)).map((b) => listRow(b, true))));
  }
  const unassigned = all.filter((b) => !(b.roomIds || []).length && b.type !== 'Spare');
  if (unassigned.length) {
    sections.push(h('section', { class: 'room-block' }, h('header', { class: 'room-head' }, h('h3', {}, 'No room assigned')),
      unassigned.map((b) => listRow(b, true))));
  }
  results.append(sections.length ? h('div', {}, sections) : emptyState('No breakers are linked to rooms yet. Edit a breaker and add its rooms.'));
}

// ---------- editors ----------

function fixturesEditor(values) {
  let list = [...(values || [])];
  const known = [...new Set([...FIXTURES, ...store.get('breakers').flatMap((b) => b.fixtures || [])])].sort();
  const sug = suggestInput('', known, { placeholder: 'Add fixture or load…', 'aria-label': 'Add fixture' });
  const box = h('div', { class: 'chips' });
  const add = () => {
    const v = sug.input.value.trim();
    if (v && !list.includes(v)) list.push(v);
    sug.input.value = '';
    render();
    sug.input.focus();
  };
  sug.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  sug.input.addEventListener('change', () => { if (known.includes(sug.input.value)) add(); });
  function render() {
    box.replaceChildren(...list.map((f) => h('span', { class: 'chip' }, f,
      h('button', { type: 'button', 'aria-label': `Remove ${f}`, onclick: () => { list = list.filter((x) => x !== f); render(); } }, '✕'))),
    sug, h('button', { type: 'button', class: 'btn small secondary', onclick: add }, 'Add'));
  }
  render();
  return { el: box, value: () => { const pending = sug.input.value.trim(); if (pending && !list.includes(pending)) list.push(pending); return [...list]; } };
}

export function editBreaker(brk = null, panelId = state.panelId, slot = '') {
  const b = brk || { id: uid(), panelId, slot, poles: 1, half: '', amps: 20, type: 'Standard', roomIds: [], fixtures: [], labelScale: 1 };
  const panelEl = select(panels().map((p) => [p.id, panelLabel(p)]), b.panelId);
  const slotEl = input(b.slot, { type: 'number', min: 1, step: 1, required: true });
  const poles = select([['1', '1-pole'], ['2', '2-pole'], ['3', '3-pole']], String(b.poles || 1));
  const half = select([['', 'Full-size'], ['A', 'Tandem — A'], ['B', 'Tandem — B']], b.half || '');
  const amps = suggestInput(b.amps, AMPS.map(String), { inputmode: 'numeric', placeholder: 'Amps' });
  const type = select(TYPES, b.type || 'Standard');
  const label = input(b.label, { placeholder: 'e.g. Kitchen counter outlets' });
  const roomsPick = roomMultiPicker(b.roomIds || []);
  const fixtures = fixturesEditor(b.fixtures);
  const gauge = select([['', '—'], ...GAUGES], b.wireGauge || '');
  const wireType = suggestInput(b.wireType, WIRE_TYPES, {});
  const feeds = select([], b.feedsPanelId || '');
  const fillFeeds = () => setOptions(feeds, [['', '— none —'], ...panels().filter((p) => p.id !== panelEl.value).map((p) => [p.id, panelLabel(p)])], feeds.value || b.feedsPanelId || '');
  fillFeeds();
  panelEl.addEventListener('change', fillFeeds);
  const scale = input(b.labelScale ?? 1, { type: 'range', min: 0.5, max: 1.6, step: 0.05 });
  const scaleOut = h('output', {}, `${Math.round((b.labelScale ?? 1) * 100)}%`);
  scale.addEventListener('input', () => { scaleOut.textContent = `${Math.round(scale.value * 100)}%`; });
  const notes = textarea(b.notes);

  openModal({
    title: brk ? `Breaker ${slotText(brk)}` : 'New breaker',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Panel', panelEl),
      field('Slot', slotEl, { hint: 'First (top) space it occupies' }),
      field('Poles', poles),
      field('Tandem', half),
      field('Amps', amps),
      field('Type', type),
      field('Label', label, { wide: true }),
      field('Rooms', roomsPick.el, { wide: true }),
      field('Fixtures & loads', fixtures.el, { wide: true }),
      field('Wire gauge', gauge),
      field('Wire type', wireType),
      field('Feeds sub-panel', feeds),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Legend font scale'), h('div', { class: 'range-row' }, scale, scaleOut)),
      field('Notes', notes, { wide: true })),
    onSave: () => {
      const panel = panelById(panelEl.value);
      const s = Number(slotEl.value);
      if (!panel) { toast('Choose a panel', 'error'); return false; }
      if (!Number.isInteger(s) || s < 1 || s > (Number(panel.spaces) || 40)) {
        toast(`Slot must be 1–${panel.spaces || 40}`, 'error');
        return false;
      }
      const rec = {
        ...b,
        panelId: panel.id,
        slot: s,
        poles: Number(poles.value),
        half: half.value,
        amps: amps.input.value.trim() ? Number(amps.input.value) || amps.input.value.trim() : '',
        type: type.value,
        label: label.value.trim(),
        roomIds: roomsPick.value(),
        fixtures: fixtures.value(),
        wireGauge: gauge.value,
        wireType: wireType.input.value.trim(),
        feedsPanelId: feeds.value,
        labelScale: Number(scale.value),
        notes: notes.value.trim(),
      };
      const mine = new Set(slotsOf(rec));
      const clash = breakersIn(panel.id).find((o) => o.id !== rec.id && slotsOf(o).some((x) => mine.has(x))
        && !(rec.half && o.half && o.half !== rec.half && Number(o.slot) === rec.slot && (Number(o.poles) || 1) === 1 && rec.poles === 1));
      if (clash) toast(`Note: overlaps “${breakerTitle(clash)}” in slot ${slotText(clash)}`, 'error');
      saveRecord('breakers', rec);
      state.panelId = panel.id;
      return true;
    },
    onDelete: brk ? async () => {
      if (!(await confirmDialog(`Delete breaker ${slotText(brk)} (${breakerTitle(brk)})?`))) return false;
      store.remove('breakers', brk.id);
      return true;
    } : null,
  });
}

export function editPanel(panel = null) {
  const p = panel || { id: uid(), kind: panels().length ? 'sub' : 'main', legs: 2, spaces: 40, phaseColors: [...DEFAULT_PHASE], voltage: VOLTAGES[0] };
  const name = input(p.name, { placeholder: panels().length ? 'e.g. Garage sub-panel' : 'e.g. Main panel' });
  const property = suggestInput(p.property, properties(), { placeholder: 'e.g. Main house' });
  const location = input(p.location, { placeholder: 'e.g. Basement, north wall' });
  const kind = select([['main', 'Main panel'], ['sub', 'Sub-panel']], p.kind || 'main');
  const legsEl = select([['1', '1 phase color'], ['2', '2 legs (split-phase)'], ['3', '3 phases']], String(legs(p)));
  const colors = [0, 1, 2].map((i) => input((p.phaseColors || DEFAULT_PHASE)[i] || DEFAULT_PHASE[i], { type: 'color', 'aria-label': `Phase ${i + 1} color` }));
  const colorRow = h('div', { class: 'color-row' });
  const showColors = () => colorRow.replaceChildren(...colors.slice(0, Number(legsEl.value)).map((c, i) => h('label', { class: 'inline' }, `L${i + 1} `, c)));
  legsEl.addEventListener('change', showColors);
  showColors();
  const spaces = input(p.spaces || 40, { type: 'number', min: 2, max: 84, step: 2 });
  const mainAmps = suggestInput(p.mainAmps, ['60', '100', '125', '150', '200', '225', '400'], { inputmode: 'numeric' });
  const voltage = suggestInput(p.voltage, VOLTAGES, {});
  const notes = textarea(p.notes);

  openModal({
    title: panel ? 'Edit panel' : 'New panel',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Name', name),
      field('Property', property),
      field('Location', location),
      field('Kind', kind),
      field('Phase colors', legsEl),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Colors'), colorRow),
      field('Spaces', spaces, { hint: 'Total breaker spaces (both columns)' }),
      field('Main breaker (A)', mainAmps),
      field('Service', voltage),
      field('Notes', notes, { wide: true })),
    onSave: () => {
      if (!name.value.trim()) { toast('Name the panel', 'error'); return false; }
      const n = Math.max(2, Math.round(Number(spaces.value) || 40));
      saveRecord('panels', {
        ...p,
        name: name.value.trim(),
        property: property.input.value.trim(),
        location: location.value.trim(),
        kind: kind.value,
        legs: Number(legsEl.value),
        phaseColors: colors.map((c) => c.value),
        spaces: n + (n % 2),
        mainAmps: mainAmps.input.value.trim(),
        voltage: voltage.input.value.trim(),
        notes: notes.value.trim(),
      });
      state.panelId = p.id;
      return true;
    },
    onDelete: panel ? async () => {
      const bs = breakersIn(panel.id);
      if (!(await confirmDialog(`Delete “${panel.name}” and its ${bs.length} breaker(s)?`))) return false;
      store.save('breakers', store.get('breakers')
        .filter((b) => b.panelId !== panel.id)
        .map((b) => (b.feedsPanelId === panel.id ? { ...b, feedsPanelId: '' } : b)));
      store.remove('panels', panel.id);
      return true;
    } : null,
  });
}

// ---------- printable legend ----------

const PAPER = {
  letter: ['Letter 8.5×11 in', 8.5, 11],
  legal: ['Legal 8.5×14 in', 8.5, 14],
  a4: ['A4 210×297 mm', 8.27, 11.69],
  half: ['Half letter 5.5×8.5 in', 5.5, 8.5],
  card46: ['Index card 4×6 in', 4, 6],
  card57: ['5×7 in', 5, 7],
  custom: ['Custom…', null, null],
};

function legendTable(panel, o) {
  const { R, placed, conflicts } = layout(panel);
  const start = new Map(placed.map((g) => [`${g.side}:${g.row}`, g]));
  const skip = new Set();
  for (const g of placed) for (let i = 1; i < g.span; i++) skip.add(`${g.side}:${g.row + i}`);
  const desc = (g) => g.items.map((b) => h('div', { class: 'lg-item', style: `font-size:${(o.font * (b.labelScale ?? 1)).toFixed(2)}pt` },
    h('span', { class: 'lg-label' }, `${b.half ? `${b.half}: ` : ''}${breakerTitle(b)}`),
    o.details ? h('span', { class: 'lg-sub' }, [ratingText(b), TYPE_BADGE[b.type], o.rooms && b.label ? roomsText(b) : '', o.wire ? b.wireGauge : ''].filter(Boolean).join(' · ')) : null));
  const num = (slot, row) => h('td', { class: 'lg-num', style: o.colors ? `border-left-color:${phaseColor(panel, row)}` : '' }, String(slot));
  const tbody = h('tbody');
  for (let r = 1; r <= R; r++) {
    const tr = h('tr');
    tr.append(num(2 * r - 1, r));
    for (const side of [0, 1]) {
      const key = `${side}:${r}`;
      if (skip.has(key)) continue;
      const g = start.get(key);
      tr.append(h('td', { class: 'lg-desc', rowspan: g ? g.span : 1 }, g ? desc(g) : ''));
    }
    tr.append(num(2 * r, r));
    tbody.append(tr);
  }
  const fed = store.get('breakers').find((b) => b.feedsPanelId === panel.id);
  return h('div', { class: `legend${o.fill ? ' fill' : ''}` },
    h('div', { class: 'lg-title', style: `font-size:${(o.font * 1.35).toFixed(1)}pt` }, o.title || panel.name),
    h('div', { class: 'lg-meta', style: `font-size:${(o.font * 0.85).toFixed(1)}pt` },
      [panel.location, panel.mainAmps ? `${panel.mainAmps}A main` : '', panel.voltage, fed ? `Fed from ${panelById(fed.panelId)?.name} #${slotText(fed)}` : ''].filter(Boolean).join(' · ')),
    h('table', { class: 'lg-table' }, tbody),
    conflicts.length ? h('div', { class: 'lg-meta' }, `Unplaced: ${conflicts.map((b) => `${slotText(b)} ${breakerTitle(b)}`).join('; ')}`) : null);
}

function printLegend(panel) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('homeinv.legendPrefs')) || {}; } catch { return {}; } })();
  const o = { paper: 'letter', landscape: false, w: 8.5, hgt: 11, margin: 0.4, font: 9, colors: true, details: true, rooms: true, wire: false, fill: true, title: '', ...saved };

  const paper = select(Object.entries(PAPER).map(([k, v]) => [k, v[0]]), o.paper);
  const orient = select([['p', 'Portrait'], ['l', 'Landscape']], o.landscape ? 'l' : 'p');
  const w = input(o.w, { type: 'number', min: 1, step: 0.1 });
  const hgt = input(o.hgt, { type: 'number', min: 1, step: 0.1 });
  const margin = input(o.margin, { type: 'number', min: 0, step: 0.05 });
  const font = input(o.font, { type: 'range', min: 5, max: 16, step: 0.5 });
  const fontOut = h('output', {}, `${o.font} pt`);
  const title = input(panel.name, {});
  const checks = Object.fromEntries(['colors', 'details', 'rooms', 'wire', 'fill'].map((k) => {
    const c = h('input', { type: 'checkbox' });
    c.checked = !!o[k];
    return [k, c];
  }));
  const preview = h('div', { class: 'lg-preview' });

  const read = () => {
    o.paper = paper.value;
    o.landscape = orient.value === 'l';
    if (o.paper !== 'custom') {
      const [, pw, ph] = PAPER[o.paper];
      [o.w, o.hgt] = o.landscape ? [ph, pw] : [pw, ph];
      w.value = o.w; hgt.value = o.hgt;
    } else {
      o.w = Number(w.value) || 8.5; o.hgt = Number(hgt.value) || 11;
    }
    w.disabled = hgt.disabled = o.paper !== 'custom';
    o.margin = Math.max(0, Number(margin.value) || 0);
    o.font = Number(font.value);
    fontOut.textContent = `${o.font} pt`;
    o.title = title.value.trim();
    for (const [k, c] of Object.entries(checks)) o[k] = c.checked;
  };
  const render = () => {
    read();
    const page = h('div', { class: 'lg-page', style: `width:${o.w}in;height:${o.hgt}in;padding:${o.margin}in` }, legendTable(panel, o));
    const scale = Math.min(1, 320 / (o.w * 96));
    preview.style.height = `${o.hgt * 96 * scale + 2}px`;
    preview.style.width = `${o.w * 96 * scale + 2}px`;
    page.style.transform = `scale(${scale})`;
    preview.replaceChildren(page);
  };
  for (const el of [paper, orient, w, hgt, margin, font, title, ...Object.values(checks)]) el.addEventListener('input', render);
  render();

  const doPrint = () => {
    read();
    try { localStorage.setItem('homeinv.legendPrefs', JSON.stringify({ ...o, title: '' })); } catch { /* private mode */ }
    const root = document.getElementById('print-root');
    root.replaceChildren(h('div', { class: 'lg-page print', style: `width:${o.w - 2 * o.margin}in;height:${o.hgt - 2 * o.margin - 0.01}in` }, legendTable(panel, o)));
    const style = h('style', { id: 'page-size' }, `@page { size: ${o.w}in ${o.hgt}in; margin: ${o.margin}in; }`);
    document.getElementById('page-size')?.remove();
    document.head.append(style);
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); root.replaceChildren(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };

  const chk = (k, text) => h('label', { class: 'inline' }, checks[k], ` ${text}`);
  openModal({
    title: `Legend — ${panel.name}`,
    wide: true,
    body: h('div', { class: 'legend-dialog' },
      h('div', { class: 'form-grid' },
        field('Paper', paper),
        field('Orientation', orient),
        field('Width (in)', w),
        field('Height (in)', hgt),
        field('Margin (in)', margin),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Base font size'), h('div', { class: 'range-row' }, font, fontOut)),
        field('Title', title, { wide: true }),
        h('div', { class: 'field wide checks' }, chk('colors', 'Phase colors'), chk('details', 'Amps & type'), chk('rooms', 'Rooms'), chk('wire', 'Wire gauge'), chk('fill', 'Stretch to page height'))),
      h('p', { class: 'muted' }, 'Per-label size: edit a breaker and adjust “Legend font scale”. In the print dialog choose “Save as PDF” and set scale to 100%.'),
      preview),
    extraActions: [h('button', { type: 'button', class: 'btn', onclick: doPrint }, 'Print / Save PDF')],
  });
}
