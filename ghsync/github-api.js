// Thin GitHub Contents API client. Auth is a fine-grained PAT scoped to a
// single private data repo, kept in localStorage and never rendered back into
// the DOM. The repo it targets is configured at runtime, so a user can point
// the app at their own repo without a redeploy.

const API = 'https://api.github.com';

// Every read uses cache: 'no-store'. GitHub marks API responses cacheable for
// 60 s (Cache-Control: private, max-age=60), so a browser would otherwise
// answer a re-read straight after a write — the conflict-merge path — with the
// previous sha, and every retry would 409 until the push gave up.

export class NotConfiguredError extends Error {
  constructor() {
    super('No data repository configured — set one in Settings');
    this.name = 'NotConfiguredError';
  }
}

export class ConflictError extends Error {
  constructor(path) {
    super(`Conflict writing ${path}`);
    this.name = 'ConflictError';
    this.path = path;
  }
}
export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthError';
  }
}
export class NotFoundError extends Error {
  constructor(path) {
    super(`Not found: ${path}`);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

// The PAT lives under a per-app key so two ghsync apps on the same origin
// keep separate tokens (they usually have separate data repos).
export function createTokenStore(tokenKey) {
  return {
    get: () => localStorage.getItem(tokenKey) || '',
    set(t) {
      if (t) localStorage.setItem(tokenKey, t.trim());
      else localStorage.removeItem(tokenKey);
    },
    has() {
      return !!(localStorage.getItem(tokenKey) || '');
    },
  };
}

async function check(res, path) {
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub auth failed (${res.status})`);
  if (res.status === 404) throw new NotFoundError(path);
  if (res.status === 409 || res.status === 422) throw new ConflictError(path);
  throw new Error(`GitHub API ${res.status} for ${path}`);
}

// Folder inside the data repo, canonicalised: blank -> 'data' (the default),
// '/' -> '/' (the repo root), otherwise trimmed with no leading/trailing
// slashes. Idempotent. Throws on '.'/'..' segments or backslashes rather than
// guessing what was meant.
export function normalizeDir(dir) {
  const raw = String(dir ?? '').trim();
  if (!raw) return 'data';
  const d = raw.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!d) return '/';
  if (d.includes('\\') || d.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`Invalid folder: ${dir}`);
  }
  return d;
}

// UTF-8-safe base64 helpers (btoa alone breaks on non-ASCII text).
// Chunked, because spreading a large array into fromCharCode overflows the
// call stack (RangeError) once a file passes ~100 KB.
function b64encode(str) {
  const u8 = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// repoCfgOrGetter: either a {owner, repo, branch} object or a function
// returning one. The getter form lets Settings retarget the data repo
// without a reload, since every call re-reads the current config.
// tokens: a token store from createTokenStore().
export function makeClient(repoCfgOrGetter, tokens) {
  const headers = () => ({
    Authorization: `Bearer ${tokens.get()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  const raw = () => (typeof repoCfgOrGetter === 'function' ? repoCfgOrGetter() : repoCfgOrGetter);
  const cfg = () => {
    const c = raw();
    if (!c?.owner || !c?.repo) throw new NotConfiguredError();
    return { branch: 'main', ...c };
  };
  const base = () => `${API}/repos/${cfg().owner}/${cfg().repo}/contents`;

  // Folder mapping. Apps address files by logical paths under `data/`; the
  // configured `dir` (default 'data', '' = repo root) is where that tree lives
  // in the repo, so one private repo can hold several apps' data side by side.
  const dir = () => { const d = normalizeDir(cfg().dir); return d === '/' ? '' : d; };
  const remote = (path) => {
    if (path !== 'data' && !path.startsWith('data/')) return path;
    const rest = path.slice(5); // after 'data/'
    return dir() ? (rest ? `${dir()}/${rest}` : dir()) : rest;
  };
  const logical = (path) => {
    const d = dir();
    if (!d) return `data/${path}`;
    return path === d ? 'data' : path.startsWith(`${d}/`) ? `data/${path.slice(d.length + 1)}` : path;
  };
  const url = (path) => `${base()}/${remote(path).split('/').map(encodeURIComponent).join('/')}`;

  return {
    isConfigured() {
      try {
        cfg();
        return true;
      } catch {
        return false;
      }
    },
    target() {
      const c = raw();
      return c?.owner && c?.repo ? { branch: 'main', ...c } : null;
    },
    // -> { content: string, sha } ; throws NotFoundError if absent.
    // Files over 1 MB come back from the JSON endpoint with empty content
    // (encoding "none"); fetch those again with the raw media type (≤ 100 MB).
    async getFile(path) {
      const u = `${url(path)}?ref=${encodeURIComponent(cfg().branch)}`;
      const res = await fetch(u, { headers: headers(), cache: 'no-store' });
      await check(res, path);
      const json = await res.json();
      if (json.encoding === 'none' || (!json.content && json.size > 0)) {
        const raw = await fetch(u, { headers: { ...headers(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
        await check(raw, path);
        return { content: await raw.text(), sha: json.sha };
      }
      return { content: b64decode(json.content), sha: json.sha };
    },

    // sha: pass null on create. -> new sha. Throws ConflictError on sha mismatch.
    async putFile(path, content, sha, message) {
      const body = {
        message,
        content: b64encode(content),
        branch: cfg().branch,
      };
      if (sha) body.sha = sha;
      const res = await fetch(url(path), {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await check(res, path);
      const json = await res.json();
      return json.content.sha;
    },

    // sha is required by the API. Throws ConflictError on sha mismatch.
    async deleteFile(path, sha, message) {
      const res = await fetch(url(path), {
        method: 'DELETE',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sha, branch: cfg().branch }),
      });
      await check(res, path);
    },

    // -> [{ name, path, sha }] with logical paths ; [] if the directory doesn't exist yet
    async listDir(path) {
      const res = await fetch(`${url(path)}?ref=${encodeURIComponent(cfg().branch)}`, { headers: headers(), cache: 'no-store' });
      if (res.status === 404) return [];
      await check(res, path);
      const json = await res.json();
      return Array.isArray(json) ? json.map(({ name, path: p, sha }) => ({ name, path: logical(p), sha })) : [];
    },

    // Where a logical path lives in the repo (for display).
    remotePath: (path) => remote(path),

    // Run a workflow in the data repo via workflow_dispatch. Only needed by
    // apps whose data repo has Actions; the PAT then also needs Actions:write.
    async dispatchWorkflow(workflowFile) {
      const res = await fetch(
        `${API}/repos/${cfg().owner}/${cfg().repo}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: cfg().branch }),
        },
      );
      await check(res, workflowFile);
    },

    // Cheap validity probe for the settings panel. -> { private: boolean }
    async validate() {
      const res = await fetch(`${API}/repos/${cfg().owner}/${cfg().repo}`, { headers: headers(), cache: 'no-store' });
      await check(res, 'repo');
      const json = await res.json().catch(() => ({}));
      return { private: json.private !== false };
    },
  };
}
