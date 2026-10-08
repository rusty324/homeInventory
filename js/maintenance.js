// Home maintenance tracker: recurring (or one-time) tasks with an interval,
// a completion history with notes and costs, links to the room and to the
// inventory item they concern (so the furnace's manual is one tap away), a
// starter list of common tasks, and an .ics export so a phone calendar can do
// the reminding — a static site can't send notifications itself.

import {
  h, uid, input, textarea, field, select, setOptions, suggestInput, openModal, confirmDialog,
  toast, matches, byText, clear, emptyState, segmented, money, shortDate,
} from './ui.js';
import { store, saveRecord } from './sync.js';
import { roomName, roomSelect } from './rooms.js';
import { docLinks } from './docs-ui.js';

export const CATEGORIES = ['HVAC', 'Plumbing', 'Electrical', 'Safety', 'Appliances', 'Exterior', 'Interior', 'Yard', 'Vehicle', 'Other'];
const UNITS = [['days', 'days'], ['weeks', 'weeks'], ['months', 'months'], ['years', 'years'], ['once', 'one time']];

// [category, name, every, unit, notes]
export const PRESETS = [
  ['HVAC', 'Replace HVAC air filter', 3, 'months', 'Record the filter size in Parts, e.g. 16×25×1 MERV 8.'],
  ['HVAC', 'HVAC professional tune-up', 1, 'years', ''],
  ['HVAC', 'Clean AC condenser coils', 1, 'years', 'Power off at the disconnect first.'],
  ['Plumbing', 'Drain / flush water heater', 1, 'years', 'Removes sediment. Check the anode rod every 3–5 years.'],
  ['Plumbing', 'Test water heater T&P relief valve', 1, 'years', ''],
  ['Plumbing', 'Replace refrigerator water filter', 6, 'months', ''],
  ['Plumbing', 'Replace whole-house water filter', 6, 'months', ''],
  ['Plumbing', 'Test sump pump', 3, 'months', 'Pour water into the pit until the float trips.'],
  ['Plumbing', 'Add water softener salt', 1, 'months', ''],
  ['Safety', 'Test smoke & CO alarms', 1, 'months', ''],
  ['Safety', 'Replace smoke & CO alarm batteries', 1, 'years', ''],
  ['Safety', 'Replace smoke alarms', 10, 'years', 'Check the manufacture date on the back.'],
  ['Safety', 'Check fire extinguisher gauge', 1, 'months', ''],
  ['Electrical', 'Test GFCI outlets & breakers', 1, 'months', ''],
  ['Appliances', 'Clean dryer vent duct', 1, 'years', ''],
  ['Appliances', 'Clean range hood filter', 3, 'months', ''],
  ['Appliances', 'Vacuum refrigerator coils', 1, 'years', ''],
  ['Appliances', 'Clean dishwasher filter', 1, 'months', ''],
  ['Exterior', 'Clean gutters & downspouts', 6, 'months', ''],
  ['Exterior', 'Inspect roof & flashing', 1, 'years', ''],
  ['Exterior', 'Winterize outdoor faucets & irrigation', 1, 'years', ''],
  ['Exterior', 'Chimney inspection & sweep', 1, 'years', ''],
  ['Exterior', 'Test garage door auto-reverse', 1, 'months', ''],
];

// ---------- dates (local calendar days as 'YYYY-MM-DD') ----------

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => isoOf(new Date());
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86_400_000);

export function addInterval(iso, n, unit) {
  const d = parse(iso);
  n = Number(n) || 1;
  if (unit === 'days') d.setDate(d.getDate() + n);
  else if (unit === 'weeks') d.setDate(d.getDate() + 7 * n);
  else if (unit === 'months' || unit === 'years') {
    const months = unit === 'years' ? 12 * n : n;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); // Jan 31 + 1 month -> Feb 28/29
  }
  return isoOf(d);
}

const approxDays = (t) => (Number(t.every) || 1) * ({ days: 1, weeks: 7, months: 30, years: 365 }[t.unit] || 30);

// Next due date, or null for paused / finished one-time tasks.
export function dueDate(t) {
  if (t.paused) return null;
  if (t.unit === 'once') return t.lastDone ? null : (t.firstDue || today());
  return t.lastDone ? addInterval(t.lastDone, t.every, t.unit) : (t.firstDue || today());
}

// -> { key: 'overdue' | 'soon' | 'later' | 'done' | 'paused', days }
export function statusOf(t) {
  if (t.paused) return { key: 'paused' };
  const due = dueDate(t);
  if (!due) return { key: 'done' };
  const days = daysBetween(today(), due);
  const window = t.unit === 'once' ? 14 : Math.min(30, Math.max(3, Math.round(approxDays(t) * 0.15)));
  return { key: days < 0 ? 'overdue' : days <= window ? 'soon' : 'later', days, due };
}

const everyText = (t) => (t.unit === 'once' ? 'One time' : `Every ${Number(t.every) === 1 ? '' : `${t.every} `}${Number(t.every) === 1 ? t.unit.replace(/s$/, '') : t.unit}`);

function dueText(s) {
  if (s.key === 'paused') return 'Paused';
  if (s.key === 'done') return 'Done';
  if (s.days < 0) return `${-s.days}d late`;
  if (s.days === 0) return 'Today';
  if (s.days === 1) return 'Tomorrow';
  if (s.days < 60) return `In ${s.days}d`;
  return shortDate(s.due);
}

export const tasks = () => store.get('tasks');
export const overdueCount = () => tasks().filter((t) => statusOf(t).key === 'overdue').length;
const itemById = (id) => store.get('items').find((i) => i.id === id);

// ---------- tab ----------

const state = { q: '', category: '', view: 'upcoming' };
let results;
let catFilter;

export function mount(root) {
  results = h('div', { class: 'results' });
  const q = input(state.q, { type: 'search', placeholder: 'Search tasks, parts, notes…', 'aria-label': 'Search maintenance' });
  q.addEventListener('input', () => { state.q = q.value; refresh(); });
  catFilter = select([], state.category, { 'aria-label': 'Filter by category' });
  catFilter.addEventListener('change', () => { state.category = catFilter.value; refresh(); });
  root.append(
    h('div', { class: 'toolbar' }, q, h('button', { class: 'btn', onclick: () => editTask() }, '+ Task')),
    h('div', { class: 'toolbar filters' },
      catFilter,
      segmented([{ value: 'upcoming', label: 'Upcoming' }, { value: 'history', label: 'History' }], state.view, (v) => { state.view = v; refresh(); }),
      h('button', { class: 'btn secondary', onclick: openPresets }, 'Common tasks…'),
      h('button', { class: 'btn secondary', onclick: exportIcs, title: 'Add the schedule to your phone or computer calendar' }, 'Calendar (.ics)')),
    results);
  refresh();
}

export function refresh() {
  if (!results) return;
  const used = [...new Set(tasks().map((t) => t.category).filter(Boolean))];
  setOptions(catFilter, [['', 'All categories'], ...[...new Set([...CATEGORIES, ...used])].filter((c) => used.includes(c))], state.category);
  state.category = catFilter.value;
  clear(results);
  if (!tasks().length) {
    results.append(emptyState('Track recurring upkeep — filters, flushing the water heater, testing alarms — and see what’s due.',
      h('div', { class: 'field-row' },
        h('button', { class: 'btn', onclick: openPresets }, 'Pick from common tasks'),
        h('button', { class: 'btn secondary', onclick: () => editTask() }, '+ Custom task'))));
    return;
  }
  if (state.view === 'history') renderHistory();
  else renderUpcoming();
}

const visible = (t) => (!state.category || t.category === state.category)
  && matches(state.q, t.name, t.category, t.parts, t.notes, roomName(t.roomId), itemById(t.itemId)?.name);

function taskRow(t) {
  const s = statusOf(t);
  const item = itemById(t.itemId);
  const sub = [
    everyText(t),
    t.lastDone ? `last ${shortDate(t.lastDone)}` : 'never logged',
    t.category, roomName(t.roomId), item ? item.name : '', t.parts,
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'list-row task-row tappable', onclick: () => editTask(t) },
    h('span', { class: `due-pill ${s.key}`, title: s.due ? `Due ${shortDate(s.due)}` : '' }, dueText(s)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, t.name),
      h('div', { class: 'row-sub' }, sub),
      item?.manuals?.length ? docLinks(item.manuals, { compact: true }) : null),
    s.key === 'paused' || s.key === 'done' ? null
      : h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); markDone(t); } }, '✓ Done'));
}

function renderUpcoming() {
  const groups = { overdue: [], soon: [], later: [], done: [], paused: [] };
  for (const t of tasks().filter(visible)) groups[statusOf(t).key].push(t);
  const byDue = (a, b) => (dueDate(a) || '9999').localeCompare(dueDate(b) || '9999') || byText((t) => t.name)(a, b);
  const titles = { overdue: 'Overdue', soon: 'Due soon', later: 'Later', done: 'Completed one-time tasks', paused: 'Paused' };
  const sections = Object.entries(groups).filter(([, list]) => list.length).map(([key, list]) =>
    h('section', { class: `room-block group-${key}` },
      h('header', { class: 'room-head' }, h('h3', {}, titles[key]), h('span', { class: 'muted' }, String(list.length))),
      list.sort(byDue).map(taskRow)));
  results.append(sections.length ? h('div', {}, sections) : emptyState('No tasks match.'));
}

function renderHistory() {
  const entries = [];
  for (const t of tasks().filter(visible)) for (const e of t.history || []) entries.push({ t, e });
  entries.sort((a, b) => b.e.date.localeCompare(a.e.date));
  if (!entries.length) { results.append(emptyState('Nothing logged yet. Press “✓ Done” on a task to record it.')); return; }
  const byYear = new Map();
  for (const { e } of entries) {
    const y = e.date.slice(0, 4);
    byYear.set(y, (byYear.get(y) || 0) + (Number(e.cost) || 0));
  }
  results.append(
    h('p', { class: 'muted' }, 'Spent: ', [...byYear].map(([y, c]) => `${y} ${money(c)}`).join(' · ')),
    h('div', { class: 'card flat' }, entries.map(({ t, e }) => h('div', { class: 'list-row tappable', onclick: () => editTask(t) },
      h('span', { class: 'due-pill later' }, shortDate(e.date)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, t.name),
        e.note ? h('div', { class: 'row-sub' }, e.note) : null),
      e.cost !== '' && e.cost != null ? h('span', { class: 'strong' }, money(e.cost)) : null))));
}

// ---------- actions ----------

export function markDone(t) {
  const date = input(today(), { type: 'date', max: today() });
  const note = input('', { placeholder: 'e.g. 16×25×1 MERV 8, used 2 bottles of descaler' });
  const cost = input('', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
  openModal({
    title: `Done: ${t.name}`,
    body: h('div', { class: 'form-grid' },
      field('Date', date), field('Cost ($)', cost), field('Note', note, { wide: true })),
    saveLabel: 'Log it',
    onSave: () => {
      if (!date.value) { toast('Pick a date', 'error'); return false; }
      t = tasks().find((x) => x.id === t.id) || t; // the row may have been rendered before a sync
      const history = [...(t.history || []), {
        id: uid(), date: date.value, note: note.value.trim(), cost: cost.value === '' ? '' : Math.round(Number(cost.value) * 100) / 100,
      }];
      const lastDone = !t.lastDone || date.value > t.lastDone ? date.value : t.lastDone;
      saveRecord('tasks', { ...t, history, lastDone });
      const next = dueDate({ ...t, lastDone });
      toast(next ? `Logged — next due ${shortDate(next)}` : 'Logged');
      return true;
    },
  });
}

export function editTask(task = null, preset = null) {
  const t = task || {
    id: uid(), every: preset?.[2] ?? 3, unit: preset?.[3] ?? 'months', category: preset?.[0] ?? '',
    name: preset?.[1] ?? '', notes: preset?.[4] ?? '', history: [], firstDue: today(),
  };
  const name = input(t.name, { placeholder: 'e.g. Replace HVAC air filter' });
  const category = suggestInput(t.category, CATEGORIES, {});
  const every = input(t.every ?? 1, { type: 'number', min: 1, step: 1, 'aria-label': 'Every', class: 'narrow' });
  const unit = select(UNITS, t.unit || 'months', { 'aria-label': 'Interval unit' });
  const lastDone = input(t.lastDone, { type: 'date', max: today() });
  const firstDue = input(t.firstDue || today(), { type: 'date' });
  const firstDueField = field('First due', firstDue, { hint: 'Used until the first time it’s logged' });
  const syncVis = () => {
    every.disabled = unit.value === 'once';
    firstDueField.hidden = !!lastDone.value && unit.value !== 'once';
  };
  unit.addEventListener('change', syncVis);
  lastDone.addEventListener('input', syncVis);
  syncVis();
  const room = roomSelect(t.roomId || '');
  const itemSel = select([['', '— none —'], ...store.get('items').slice().sort(byText((i) => i.name)).map((i) => [i.id, i.name])], t.itemId || '');
  const parts = input(t.parts, { placeholder: 'Filter size, part numbers, supplies' });
  const notes = textarea(t.notes);
  const paused = h('input', { type: 'checkbox' });
  paused.checked = !!t.paused;
  let history = [...(t.history || [])];
  const histEl = h('div', { class: 'doc-list' });
  const renderHist = () => {
    histEl.replaceChildren(...history.slice().sort((a, b) => b.date.localeCompare(a.date)).map((e) => h('div', { class: 'doc-row' },
      h('span', { class: 'due-pill later' }, shortDate(e.date)),
      h('div', { class: 'row-main' }, h('div', { class: 'row-sub' }, [e.note, e.cost !== '' && e.cost != null ? money(e.cost) : ''].filter(Boolean).join(' · ') || '—')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete log entry', onclick: () => {
        history = history.filter((x) => x !== e);
        // Keep "last done" consistent with what's left in the log.
        const latest = history.map((x) => x.date).sort().pop();
        if (lastDone.value === e.date) lastDone.value = latest || '';
        syncVis();
        renderHist();
      } }, '✕'))));
    if (!history.length) histEl.append(h('p', { class: 'muted' }, 'No completions logged.'));
  };
  renderHist();

  openModal({
    title: task ? 'Edit task' : 'New task',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Task', name, { wide: true }),
      field('Category', category),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Repeat'), h('div', { class: 'interval-row' }, every, unit)),
      field('Last done', lastDone),
      firstDueField,
      field('Room', room),
      field('Inventory item', itemSel, { hint: 'Shows its manuals on the task' }),
      field('Parts & supplies', parts, { wide: true }),
      field('Notes', notes, { wide: true }),
      h('label', { class: 'inline' }, paused, ' Paused (hide from due lists)'),
      task ? field('Log', histEl, { wide: true }) : null),
    extraActions: task && !t.paused ? [h('button', { type: 'button', class: 'btn secondary', onclick: (e) => { e.target.closest('dialog').close(); markDone(task); } }, '✓ Log done')] : [],
    onSave: () => {
      if (!name.value.trim()) { toast('Name the task', 'error'); return false; }
      if (unit.value !== 'once' && !(Number(every.value) >= 1)) { toast('Repeat interval must be at least 1', 'error'); return false; }
      saveRecord('tasks', {
        ...t,
        name: name.value.trim(),
        category: category.input.value.trim(),
        every: unit.value === 'once' ? '' : Math.round(Number(every.value)),
        unit: unit.value,
        lastDone: lastDone.value,
        firstDue: firstDue.value || today(),
        roomId: room.value,
        itemId: itemSel.value,
        parts: parts.value.trim(),
        notes: notes.value.trim(),
        paused: paused.checked,
        history,
      });
      return true;
    },
    onDelete: task ? async () => {
      if (!(await confirmDialog(`Delete “${task.name}” and its ${history.length} log entr${history.length === 1 ? 'y' : 'ies'}?`))) return false;
      store.remove('tasks', task.id);
      return true;
    } : null,
  });
}

function openPresets() {
  const have = new Set(tasks().map((t) => t.name.toLowerCase()));
  const checks = [];
  const body = h('div', {},
    h('p', { class: 'muted' }, 'New tasks start due today. If you know when one was last done, edit it and set “Last done”. Intervals are common guidance — check your manuals.'),
    ...[...new Set(PRESETS.map((p) => p[0]))].map((cat) => h('fieldset', { class: 'preset-group' },
      h('legend', {}, cat),
      PRESETS.filter((p) => p[0] === cat).map((p) => {
        const c = h('input', { type: 'checkbox', disabled: have.has(p[1].toLowerCase()) });
        checks.push([c, p]);
        return h('label', { class: 'preset' }, c, ` ${p[1]} `,
          h('span', { class: 'muted' }, have.has(p[1].toLowerCase()) ? '(added)' : `· ${everyText({ every: p[2], unit: p[3] }).toLowerCase()}`));
      }))));
  openModal({
    title: 'Common maintenance tasks',
    wide: true,
    body,
    saveLabel: 'Add selected',
    onSave: async () => {
      const picked = checks.filter(([c]) => c.checked && !c.disabled).map(([, p]) => p);
      if (!picked.length) { toast('Tick at least one task', 'error'); return false; }
      const stamp = new Date().toISOString();
      const added = picked.map(([category, name, every, unit, notes]) => ({
        id: uid(), category, name, every, unit, notes, history: [], firstDue: today(), createdAt: stamp, updatedAt: stamp,
      }));
      store.save('tasks', [...tasks(), ...added]);
      toast(`Added ${added.length} task${added.length === 1 ? '' : 's'}`);
      return true;
    },
  });
}

// ---------- calendar export ----------

const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: lines longer than 75 octets are folded with CRLF + space.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(list, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const freq = { days: 'DAILY', weeks: 'WEEKLY', months: 'MONTHLY', years: 'YEARLY' };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Home Records//Maintenance//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Home maintenance'];
  for (const t of list) {
    const s = statusOf(t);
    if (!s.due) continue;
    const start = s.days < 0 ? today() : s.due;
    const end = addInterval(start, 1, 'days');
    const desc = [t.parts && `Parts: ${t.parts}`, t.notes, t.lastDone && `Last done ${t.lastDone}`].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      `UID:${t.id}@home-records`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
      `SUMMARY:${icsText(t.name)}`);
    if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
    if (t.category) lines.push(`CATEGORIES:${icsText(t.category)}`);
    if (freq[t.unit]) lines.push(`RRULE:FREQ=${freq[t.unit]};INTERVAL=${Number(t.every) || 1}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(t.name)}`, 'TRIGGER:PT9H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function exportIcs() {
  const list = tasks().filter((t) => dueDate(t));
  if (!list.length) { toast('No scheduled tasks to export', 'error'); return; }
  const a = h('a', {
    href: URL.createObjectURL(new Blob([buildIcs(list)], { type: 'text/calendar' })),
    download: 'home-maintenance.ics',
  });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Calendar file downloaded. Re-export after logging late tasks — the file can’t update itself.');
}
