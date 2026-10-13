# Start here: adding ghsync to a new project

ghsync gives a static GitHub Pages site a private, synced, offline-capable
data store. The app stays public; the data lives as JSON in a **separate
private repo**, read and written from the browser with a fine-grained token.

## 1. Put the folder in your repo

Unzip so the repo root has a `ghsync/` folder (with `store.js` directly inside
it), then commit it:

```
your-app/
  index.html
  ghsync/      ← this folder, unchanged
```

## 2. Hand it to Claude Code

Open a Claude Code session in the repo and paste this, after replacing the
part in brackets:

```text
This repo is a static GitHub Pages site (no build step, no dependencies,
native ES modules). I've added ghsync/ for data storage. Read
ghsync/CLAUDE.md first and follow its integration recipe exactly.

The app: [describe it — e.g. "a reading log: books with title, author,
started/finished dates, rating and notes; plus a list of shelves"].

Requirements:
- One collection per kind of record, e.g. files: { books: 'data/books.json' };
  all of them encrypted. Pick a short unique appId.
- A Settings view rendering syncSections() plus setupRows(), and a sync
  status badge from badgeState().
- If records need photos or file uploads, use ghsync/blobs.js as described
  in ghsync/CLAUDE.md ("Photos / documents"); store ids in records, never
  the bytes.
- Add data/ and node_modules/ to .gitignore. Never commit personal data or
  render the token into the page.
- Add a CLAUDE.md at the repo root with short notes for future sessions,
  pointing to ghsync/CLAUDE.md for sync.
- Write a Playwright e2e test that stubs api.github.com (copy the fake from
  ghsync/tests/ghsync.test.mjs) and covers: local-only sends nothing,
  create/edit/delete reach the repo, offline queueing, a 409 merge, and no
  plaintext in encrypted PUTs. Run it, and run
  node ghsync/tests/ghsync.test.mjs, before committing.
Don't modify files inside ghsync/ unless a test shows a bug there.
```

## 3. Turn on Pages

Repo **Settings → Pages → Deploy from a branch → `main` / `(root)`**. Add an
empty `.nojekyll` file at the root so Pages serves files as-is.

## 4. Connect your data (once per device)

1. Create a **private** repo for the data, e.g. `you/books-data`. It can be
   empty. One data repo can serve several apps if each uses its own folder.
2. Create a **fine-grained personal access token**
   (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: *Only select repositories* → the data repo.
   - Permissions: **Contents: Read and write**. Nothing else.
   - Pick an expiry you're happy to renew; when it expires the app shows an
     auth error until you paste a new one.
3. In the app's Settings: owner, repo, folder (default `data`), paste the
   token, then press **Upload all local data** once.
4. On each other device (phone, laptop): same repo, folder and token. On
   iPhone, a home-screen app has its own storage separate from Safari, so
   connect it from the home-screen app itself.
5. Optional: set an encryption password in Settings → Privacy. Use the same
   password on every device. **There is no recovery if it's lost.**

## Things worth knowing before you rely on it

- Works offline; edits queue and upload later. The badge shows `pending`
  until they do, and `error` when something needs you (bad token, full
  browser storage, a broken file in the repo).
- Two devices editing the same collection are merged per record. A record
  deleted on one device can come back if another device had unsynced edits to
  that collection.
- Every save re-uploads the whole collection file. Fine for thousands of small
  records; shard by month or key long before a file reaches ~1 MB.
- GitHub keeps history. Deleting a record in the app doesn't erase it from
  old commits; only deleting the data repo does.
- The token is in the browser's localStorage. Scope it to the one data repo
  so a leak can't reach anything else.

## Running the package tests

```
npm i -D playwright
node ghsync/tests/ghsync.test.mjs
node ghsync/tests/http-cache.test.mjs   # needs openssl and port 443 (e.g. a cloud session)
```

`CHANGELOG.md` lists what changed since the first version of this package.
