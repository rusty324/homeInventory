// Small DOM helpers shared by every tab. No framework: `h()` builds elements,
// and each tab re-renders its result area from the store on change.

import { h } from '../ghsync/settings-ui.js';

export { h };

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(message, type = '') {
  const t = h('div', { class: `toast ${type}`, role: 'status' }, message);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

// Case-insensitive "every word appears somewhere in these fields".
export function matches(query, ...fields) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.flat().filter((f) => f != null).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const byText = (key) => (a, b) => String(key(a) ?? '').localeCompare(String(key(b) ?? ''), undefined, { numeric: true, sensitivity: 'base' });

export function money(n) {
  if (n === '' || n == null || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------- form controls ----------

export function field(label, control, { hint, wide } = {}) {
  // <label> only around a single control: a label wrapping buttons (chips,
  // photo tiles) would forward stray clicks to its first control.
  const simple = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) || control.classList?.contains('suggest');
  return h(simple ? 'label' : 'div', { class: `field${wide ? ' wide' : ''}` },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function input(value = '', attrs = {}) {
  const el = h('input', { type: 'text', ...attrs });
  el.value = value ?? '';
  return el;
}

export function textarea(value = '', attrs = {}) {
  const el = h('textarea', { rows: 3, ...attrs });
  el.value = value ?? '';
  return el;
}

// options: array of strings or [value, label] pairs.
export function select(options, value = '', attrs = {}) {
  const el = h('select', attrs);
  setOptions(el, options, value);
  return el;
}

export function setOptions(el, options, value = el.value) {
  clear(el);
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    el.appendChild(h('option', { value: v }, l));
  }
  el.value = value ?? '';
  if (el.value !== String(value ?? '') && el.options.length) el.selectedIndex = 0;
}

let datalistSeq = 0;
// An input with suggestions; returns the input (the datalist rides along inside a wrapper).
export function suggestInput(value, suggestions, attrs = {}) {
  const id = `dl-${++datalistSeq}`;
  const el = input(value, { ...attrs, list: id });
  const dl = h('datalist', { id }, [...new Set(suggestions.filter(Boolean))].map((s) => h('option', { value: s })));
  const wrap = h('span', { class: 'suggest' }, el, dl);
  wrap.input = el;
  return wrap;
}

// ---------- modal ----------

// Opens a <dialog>. `onSave` returns false to keep it open. Returns { close }.
// tips: { 'Field label': 'help text' } shown on hover (see tips.js).
export function openModal({ title, body, onSave, saveLabel = 'Save', onDelete, deleteLabel = 'Delete', extraActions = [], wide, tips }) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}` });
  dlg.tips = tips;
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => dlg.remove());
  const form = h('form', { method: 'dialog', novalidate: true },
    h('header', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    h('footer', { class: 'modal-foot' },
      onDelete ? h('button', {
        type: 'button',
        class: 'btn danger',
        onclick: async () => { if ((await onDelete()) !== false) close(); },
      }, deleteLabel) : null,
      ...extraActions,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn secondary', onclick: close }, onSave ? 'Cancel' : 'Close'),
      onSave ? h('button', { type: 'submit', class: 'btn' }, saveLabel) : null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSave) return close();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if ((await onSave()) !== false) close();
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });
  dlg.appendChild(form);
  document.body.appendChild(dlg);
  dlg.showModal();
  return { close, dialog: dlg };
}

export function confirmDialog(message, { okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = h('dialog', { class: 'modal confirm' },
      h('form', { method: 'dialog' },
        h('div', { class: 'modal-body' }, h('p', {}, message)),
        h('footer', { class: 'modal-foot' },
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn secondary', value: 'cancel' }, 'Cancel'),
          h('button', { class: `btn${danger ? ' danger' : ''}`, value: 'ok', onclick: () => { result = true; } }, okLabel))));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', {}, text), action || null);
}

// Segmented control: [{value,label}] -> element with onchange(value).
export function segmented(options, value, onchange) {
  const wrap = h('div', { class: 'segmented', role: 'tablist' });
  const render = () => {
    clear(wrap);
    for (const o of options) {
      wrap.appendChild(h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(o.value === value),
        class: o.value === value ? 'on' : '',
        onclick: () => { value = o.value; render(); onchange(value); },
      }, o.label));
    }
  };
  render();
  return wrap;
}
