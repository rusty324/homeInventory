// Manuals and other documents attached to records: web links, or uploaded
// files stored like photos (data/files/<id>.json, see blobs.js).
//
// Entry shapes, kept on the record:
//   { id, kind: 'link', url, label }
//   { id, kind: 'file', fileId, name, size, mime, label }
// As with photos, the editor defers uploads and deletions to commit().

import { h, toast, input, clear } from './ui.js';
import { docs } from './sync.js';
import { processDocument, MAX_DOC_BYTES } from './blobs.js';

// Only http(s) links are ever rendered as hrefs — a stored "javascript:" URL
// would otherwise run script on this origin, where the GitHub token lives.
export function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
export const docLabel = (d) => d.label || (d.kind === 'link' ? hostOf(d.url) : d.name) || 'Document';
const sizeText = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Open an uploaded file in a new tab (PDFs and images render; others download).
export async function openDoc(entry) {
  // Open the tab synchronously in the click so popup blockers allow it.
  const viewable = /^(application\/pdf|image\/|text\/)/.test(entry.mime || '');
  const win = viewable ? window.open('', '_blank') : null;
  const blob = await docs.blob(entry.fileId);
  if (!blob) {
    win?.close();
    toast('That file isn’t available on this device yet — connect the data repo, or try again online.', 'error');
    return;
  }
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: entry.mime }));
  if (win) {
    win.location.href = url;
  } else {
    const a = h('a', { href: url, download: entry.name || 'document' });
    document.body.append(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Compact list of document links for tables and cards.
export function docLinks(list = [], { compact = false } = {}) {
  const wrap = h('span', { class: `doc-links${compact ? ' compact' : ''}` });
  for (const d of list) {
    if (d.kind === 'link') {
      const href = safeUrl(d.url);
      if (!href) continue;
      wrap.append(h('a', {
        class: 'doc-link', href, target: '_blank', rel: 'noopener noreferrer', title: href,
        onclick: (e) => e.stopPropagation(),
      }, '🔗 ', h('span', {}, docLabel(d))));
    } else {
      wrap.append(h('button', {
        type: 'button', class: 'doc-link', title: `${d.name} (${sizeText(d.size || 0)})`,
        onclick: (e) => { e.stopPropagation(); openDoc(d); },
      }, '📄 ', h('span', {}, docLabel(d))));
    }
  }
  return wrap;
}

// -> { el, commit(): Promise<entry[]> }
export function docsEditor(initial = []) {
  let kept = [...initial];
  const removed = [];
  const added = []; // { entry, processed }
  const listEl = h('div', { class: 'doc-list' });
  const url = input('', { type: 'url', placeholder: 'https://… manual or product page', 'aria-label': 'Link URL', inputmode: 'url' });
  const label = input('', { placeholder: 'Label (optional)', 'aria-label': 'Link label' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.pdf,application/pdf,image/*,.txt,.doc,.docx,.xls,.xlsx' });

  const addLink = () => {
    const href = safeUrl(url.value);
    if (!href) { toast('Enter a valid http(s) link', 'error'); return; }
    added.push({ entry: { id: crypto.randomUUID(), kind: 'link', url: href, label: label.value.trim() } });
    url.value = '';
    label.value = '';
    render();
  };
  for (const el of [url, label]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });

  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      try {
        const processed = await processDocument(file);
        added.push({
          processed,
          entry: { id: crypto.randomUUID(), kind: 'file', name: processed.name, size: processed.size, mime: processed.mime, label: '' },
        });
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    fileInput.value = '';
    render();
  });

  function row(entry, onRemove) {
    const sub = entry.kind === 'link' ? entry.url.replace(/^https?:\/\/(www\.)?/, '') : `${entry.name} · ${sizeText(entry.size || 0)}`;
    return h('div', { class: 'doc-row' },
      h('span', { class: 'doc-icon' }, entry.kind === 'link' ? '🔗' : '📄'),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, docLabel(entry)),
        h('div', { class: 'row-sub' }, sub)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${docLabel(entry)}`, onclick: onRemove }, '✕'));
  }

  function render() {
    clear(listEl);
    for (const d of kept) listEl.append(row(d, () => { kept = kept.filter((k) => k !== d); removed.push(d); render(); }));
    for (const a of added) listEl.append(row(a.entry, () => { added.splice(added.indexOf(a), 1); render(); }));
  }
  render();

  return {
    el: h('div', { class: 'docs-editor' },
      listEl,
      h('div', { class: 'doc-add' },
        url, label,
        h('button', { type: 'button', class: 'btn small secondary', onclick: addLink }, 'Add link'),
        h('button', { type: 'button', class: 'btn small secondary', onclick: () => fileInput.click() }, 'Upload file…')),
      h('span', { class: 'field-hint' }, `Files up to ${MAX_DOC_BYTES / 1048576} MB. For big manuals, a link to the manufacturer’s PDF saves space.`),
      fileInput),
    async commit() {
      if (url.value.trim() && safeUrl(url.value)) addLink(); // typed but never pressed "Add link"
      const out = [...kept];
      for (const a of added) {
        if (a.processed) out.push({ ...a.entry, fileId: await docs.add(a.processed) });
        else out.push(a.entry);
      }
      for (const d of removed) if (d.kind === 'file') await docs.remove(d.fileId);
      return out;
    },
  };
}

export async function dropDocs(list = []) {
  for (const d of list) if (d.kind === 'file') await docs.remove(d.fileId);
}
