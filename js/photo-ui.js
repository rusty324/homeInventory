// Photo widgets: a lazily-loaded thumbnail, a full-size viewer, and the
// add/remove editor used inside record forms. The editor defers every change
// to commit(), so cancelling a form never leaves orphaned uploads behind.

import { h, toast } from './ui.js';
import { photos } from './sync.js';
import { processImage } from './blobs.js';

export function photoThumb(id, { size = '', onclick } = {}) {
  const img = h('img', { class: 'thumb', alt: '' });
  const wrap = h('span', { class: `thumb-wrap ${size}` }, img);
  const open = (e) => {
    e.stopPropagation();
    if (onclick) onclick();
    else photos.urls(id).then((u) => u && viewPhoto(u.full));
  };
  const show = (src) => {
    img.src = src;
    wrap.classList.remove('loading', 'missing');
    wrap.classList.add('tappable');
    wrap.title = '';
    wrap.onclick = open;
  };
  const cached = photos.cachedThumb(id);
  if (cached) { show(cached); return wrap; }
  wrap.classList.add('loading');
  // One retry: right after connecting, the first fetch can race the refresh.
  const load = (retry) => photos.urls(id).then((u) => {
    if (u) return show(u.thumb);
    if (retry) { setTimeout(() => load(false), 3000); return; }
    wrap.classList.remove('loading');
    wrap.classList.add('missing');
    wrap.title = 'Photo not available on this device yet';
  });
  load(true);
  return wrap;
}

export function viewPhoto(src) {
  const dlg = h('dialog', { class: 'lightbox', onclick: () => dlg.close() }, h('img', { src, alt: '' }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
}

// -> { el, commit(): Promise<string[]> }
export function photoEditor(initialIds = []) {
  let kept = [...initialIds];
  const removed = [];
  const added = []; // { key, processed, url }
  const grid = h('div', { class: 'photo-grid' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      try {
        const processed = await processImage(file);
        added.push({ key: crypto.randomUUID(), processed, url: `data:${processed.mime};base64,${processed.thumb}` });
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    fileInput.value = '';
    render();
  });

  function tile(content, onRemove) {
    return h('div', { class: 'photo-tile' }, content,
      h('button', { type: 'button', class: 'photo-x', 'aria-label': 'Remove photo', onclick: onRemove }, '✕'));
  }

  function render() {
    grid.replaceChildren(
      ...kept.map((id) => tile(photoThumb(id), () => { kept = kept.filter((k) => k !== id); removed.push(id); render(); })),
      ...added.map((a) => tile(h('span', { class: 'thumb-wrap' }, h('img', { class: 'thumb', src: a.url, alt: '' })),
        () => { added.splice(added.indexOf(a), 1); render(); })),
      h('button', { type: 'button', class: 'photo-add', onclick: () => fileInput.click() }, '+ Photo'),
    );
  }
  render();

  return {
    el: h('div', {}, grid, fileInput),
    async commit() {
      const ids = [...kept];
      for (const a of added) ids.push(await photos.add(a.processed));
      for (const id of removed) await photos.remove(id);
      return ids;
    },
  };
}

// Delete all photos of a record that is itself being deleted.
export async function dropPhotos(ids = []) {
  for (const id of ids) await photos.remove(id);
}
