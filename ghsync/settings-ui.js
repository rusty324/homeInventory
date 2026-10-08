// Drop-in Settings UI for ghsync: the data repository, the GitHub token, and
// the optional encryption password — the three things every ghsync app needs
// and nobody wants to rewrite.
//
// It returns section SPECS ({ id, name, state, body }) rather than a modal, so
// the host app renders them in whatever chrome it already has and can mix in
// its own sections. Zero dependencies; the markup uses plain class names
// (btn / field / field-row / muted / list-row), styled by ghsync.css if the
// host has nothing of its own.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// Why a remote action can't run yet, or null when it can.
export function syncBlocker(store) {
  const missing = [];
  if (!store.hasDataRepo()) missing.push('a data repository');
  if (!store.hasToken()) missing.push('a GitHub token');
  return missing.length ? `Set ${missing.join(' and ')} first.` : null;
}

// Header badge text/class for the current sync state.
export function badgeState(store) {
  const { status } = store.syncStatus();
  if (store.encryption().locked) return { text: '🔒 locked', cls: 'error' };
  if (status === 'local') return { text: 'local only', cls: '' };
  if (status === 'pending') return { text: 'pending sync', cls: 'pending' };
  if (status === 'error') return { text: 'sync error', cls: 'error' };
  return { text: 'synced', cls: 'ok' };
}

/**
 * @param {object} o
 * @param {object} o.store    a createStore() instance
 * @param {(msg:string, type?:string)=>void} o.toast
 * @param {()=>void} [o.onChange] re-render the host app (data or units changed)
 * @param {(sectionId:string)=>void} [o.reopen] reopen Settings on a section
 * @param {object} [o.text]   copy overrides — see DEFAULT_TEXT below
 * @returns {Array<{id:string,name:string,state:string,body:HTMLElement}>}
 */
export function syncSections({ store, toast, onChange = () => {}, reopen = () => {}, text = {} }) {
  const t = { ...DEFAULT_TEXT, ...text };
  return [dataRepoSection(), tokenSection(), privacySection()];

  // Personal data lives in a separate PRIVATE repo, not the public one that
  // serves the app. Configured here so it needs no redeploy, and left unset
  // by default so nothing personal is ever written somewhere public.
  function dataRepoSection() {
    const current = store.getDataRepo();
    const ownerInput = h('input', { value: current?.owner ?? t.defaultOwner, placeholder: 'github-username' });
    const repoInput = h('input', { value: current?.repo ?? '', placeholder: t.repoPlaceholder });
    const branchInput = h('input', { value: current?.branch ?? 'main', placeholder: 'main' });

    const blocker = syncBlocker(store);
    const seedBtn = h('button', {
      class: 'btn secondary',
      disabled: !!blocker,
      onclick: async () => {
        seedBtn.disabled = true;
        try {
          await store.pushAllData();
          toast('Uploaded all local data to the data repo');
        } catch (e) {
          toast(e.message, 'error');
        }
        seedBtn.disabled = false;
        onChange();
      },
    }, 'Upload all local data');

    const save = async () => {
      if (!repoInput.value.trim() || !ownerInput.value.trim()) {
        toast('Enter an owner and a repo name', 'error');
        return;
      }
      store.setDataRepo({ owner: ownerInput.value, repo: repoInput.value, branch: branchInput.value });
      store.refreshStatus();
      if (store.hasToken()) {
        try {
          await store.client.validate();
          toast('Data repo saved — syncing');
          store.refresh().then(onChange);
        } catch {
          toast('Saved, but GitHub could not reach that repo — check the name and token scope', 'error');
        }
      } else {
        toast('Data repo saved — now add a token below');
      }
      reopen('token');
    };

    return {
      id: 'datarepo',
      name: 'Data repository',
      state: current?.owner && current?.repo ? `${current.owner}/${current.repo}` : 'not set',
      body: h('div', {},
        h('p', { class: 'muted' },
          current?.owner && current?.repo
            ? `Syncing to ${current.owner}/${current.repo} (branch ${current.branch}). This should be a private repo.`
            : 'Not set — the app is local-only, keeping everything in this browser. '
              + 'Create a private repo on GitHub and enter it here to sync.'),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', {}, 'Owner'), ownerInput),
          h('div', { class: 'field' }, h('label', {}, 'Repo'), repoInput),
          h('div', { class: 'field' }, h('label', {}, 'Branch'), branchInput),
        ),
        h('div', { class: 'field-row' },
          h('button', { class: 'btn', onclick: save }, 'Save data repo'),
          seedBtn,
        ),
        blocker
          ? h('p', { class: 'muted', style: 'margin:6px 0 0' }, `Upload needs a token too. ${blocker}`)
          : h('p', { class: 'muted', style: 'margin:6px 0 0' },
              'Press “Upload all local data” once, right after connecting a new repo, to seed it from this browser.'),
        t.appRepoNote ? h('p', { class: 'muted' }, t.appRepoNote) : null,
      ),
    };
  }

  // The PAT used to reach the data repo. Save sits directly under the input.
  function tokenSection() {
    const patInput = h('input', {
      type: 'password',
      placeholder: store.hasToken() ? '••••••••  (token saved)' : 'github_pat_…',
      autocomplete: 'off',
    });
    const save = async () => {
      const v = patInput.value.trim();
      if (!v) {
        toast('Paste a token into the field first', 'error');
        return;
      }
      store.setToken(v);
      store.refreshStatus();
      try {
        await store.client.validate();
        toast('Token saved — syncing');
        store.flushQueue().then(() => store.refresh()).then(onChange);
      } catch (e) {
        toast(e.name === 'NotConfiguredError'
          ? 'Token saved — set a data repository above to start syncing'
          : 'Token saved, but GitHub rejected it — check its scope and expiry', 'error');
      }
      reopen('token');
    };

    return {
      id: 'token',
      name: 'GitHub token',
      state: store.hasToken() ? 'saved' : 'not set',
      body: h('div', {},
        h('p', { class: 'muted' }, t.tokenScopeNote),
        h('div', { class: 'field' }, h('label', {}, 'Personal access token'), patInput),
        h('div', { class: 'field-row' },
          h('button', { class: 'btn', onclick: save }, 'Save token'),
          h('button', {
            class: 'btn secondary',
            onclick: () => {
              store.setToken('');
              toast('Token cleared — app is local-only');
              store.refreshStatus();
              reopen('token');
            },
          }, 'Clear token'),
        ),
        h('p', { class: 'muted' },
          'The token stays in this browser (localStorage) and is only sent to api.github.com.'),
      ),
    };
  }

  // Optional password encrypting the sensitive collections in the repo
  // (AES-GCM, see crypto.js). Enable/change re-writes those files; disabling
  // decrypts them back to plaintext.
  function privacySection() {
    const { enabled, locked } = store.encryption();
    const pwInput = h('input', {
      type: 'password',
      placeholder: enabled ? 'new password…' : 'password…',
      autocomplete: 'new-password',
    });

    const apply = async () => {
      const pw = pwInput.value.trim();
      if (!pw) { toast('Enter a password first', 'error'); return; }
      setBusy(true);
      store.setPassword(pw);
      await store.refresh(); // decrypt anything currently locked
      if (store.encryption().locked) {
        toast('That password doesn’t unlock the synced files', 'error');
      } else {
        await store.rewriteEncryptedFiles();
        toast(enabled ? 'Password updated' : 'Encryption enabled');
        onChange();
      }
      setBusy(false);
      reopen('privacy');
    };
    const disable = async () => {
      if (store.encryption().locked) {
        toast('Unlock with the current password before disabling', 'error');
        return;
      }
      setBusy(true);
      store.setPassword('');
      await store.rewriteEncryptedFiles();
      toast('Encryption disabled — files stored as plaintext again');
      setBusy(false);
      onChange();
      reopen('privacy');
    };
    const applyBtn = h('button', { class: 'btn secondary', onclick: apply },
      locked ? 'Unlock' : enabled ? 'Change password' : 'Enable encryption');
    const disableBtn = enabled ? h('button', { class: 'btn secondary', onclick: disable }, 'Disable') : null;
    const setBusy = (b) => {
      applyBtn.disabled = b;
      if (disableBtn) disableBtn.disabled = b;
    };

    return {
      id: 'privacy',
      name: 'Privacy',
      state: locked ? '🔒 locked' : enabled ? 'encryption on' : 'encryption off',
      body: h('div', {},
        h('p', { class: 'muted' },
          locked ? t.privacyLocked : enabled ? t.privacyOn : t.privacyOff),
        h('div', { class: 'field' }, h('label', {}, 'Encryption password'), pwInput),
        h('div', { class: 'field-row' }, applyBtn, disableBtn),
        h('p', { class: 'muted' },
          '⚠ There is no recovery: a lost password means the encrypted data can’t be read.'),
      ),
    };
  }
}

// One checklist row: "what do I still need to do?" at a glance.
export function checkRow(label, done, detail, onClick) {
  return h('div', { class: 'list-row check-row tappable', onclick: onClick },
    h('span', { class: `mark ${done ? 'done' : 'todo'}` }, done ? '✓' : '○'),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, label),
      h('div', { class: 'row-sub' }, detail),
    ),
  );
}

// The two setup steps every ghsync app has. Host apps append their own rows.
export function setupRows(store, reveal) {
  const repo = store.getDataRepo();
  return [
    checkRow('Data repository', store.hasDataRepo(),
      store.hasDataRepo() ? `${repo.owner}/${repo.repo}` : 'not set — tap to configure',
      () => reveal('datarepo')),
    checkRow('GitHub token', store.hasToken(),
      store.hasToken() ? 'saved in this browser' : 'not set — tap to add',
      () => reveal('token')),
  ];
}

const DEFAULT_TEXT = {
  defaultOwner: '',
  repoPlaceholder: 'my-app-data',
  appRepoNote: '',
  tokenScopeNote: 'A fine-grained personal access token scoped to only your private data repo, '
    + 'with Contents read/write. It needs no access to the public repo that serves this app.',
  privacyLocked: 'Some synced files are encrypted and the password is missing or wrong — '
    + 'enter it below to unlock.',
  privacyOn: 'Your data is encrypted in the repo.',
  privacyOff: 'Optional second layer: encrypt your data before it is committed.',
};
