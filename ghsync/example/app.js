// The whole of a ghsync app: describe your collections, render the settings
// sections, and use get/upsert/remove. Everything else — caching, offline
// queueing, conflict merging, encryption — comes from the package.

import { createStore } from '../store.js';
import { syncSections, setupRows, h, badgeState } from '../settings-ui.js';

const store = createStore({
  appId: 'notes',                      // localStorage namespace
  files: { notes: 'data/notes.json' }, // collection -> path in the data repo
  encrypted: ['notes'],                // encrypted when a password is set
});

const $ = (id) => document.getElementById(id);

function toast(message, type = '') {
  const t = h('div', { class: `toast ${type}` }, message);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function renderBadge() {
  const { text, cls } = badgeState(store);
  $('badge').className = `gh-badge ${cls}`;
  $('badge').textContent = text;
}

function renderNotes() {
  const list = $('notes');
  list.innerHTML = '';
  const notes = store.get('notes').slice().reverse();
  if (!notes.length) list.appendChild(h('p', { class: 'muted' }, 'No notes yet.'));
  for (const note of notes) {
    list.appendChild(h('div', { class: 'list-row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, note.text),
        h('div', { class: 'row-sub' }, new Date(note.createdAt).toLocaleString()),
      ),
      h('button', {
        class: 'btn secondary',
        onclick: () => store.remove('notes', note.id).then(renderNotes),
      }, 'Delete'),
    ));
  }
}

function renderSettings() {
  const panel = $('settings');
  panel.innerHTML = '';
  const sections = syncSections({
    store,
    toast,
    onChange: () => { renderBadge(); renderNotes(); },
    reopen: () => renderSettings(),
    text: { repoPlaceholder: 'my-notes-data' },
  });
  panel.appendChild(h('div', {}, setupRows(store, (id) => {
    panel.querySelector(`.settings-section[data-section="${id}"]`).open = true;
  })));
  for (const spec of sections) {
    panel.appendChild(h('details', { class: 'settings-section', dataset: { section: spec.id } },
      h('summary', {},
        h('span', { class: 'sec-name' }, spec.name),
        h('span', { class: 'sec-state' }, spec.state)),
      h('div', { class: 'settings-body' }, spec.body)));
  }
}

$('settings-btn').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
  if (!$('settings').hidden) renderSettings();
});
$('add-note').addEventListener('click', async () => {
  const text = $('new-note').value.trim();
  if (!text) return;
  $('new-note').value = '';
  await store.upsert('notes', { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() });
  renderNotes();
});

store.onChange((e) => {
  if (e.type === 'sync-status') renderBadge();
  else renderNotes();
});
store.init();
renderBadge();
renderNotes();
