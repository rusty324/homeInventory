// The one ghsync store for the whole site, plus the attachment side-stores.
//
// Every collection is browser-owned and personal, so all are encrypted once a
// password is set. Attachments are app-owned paths under data/photos/ and
// data/files/ (see blobs.js), claimed by encryptPath so they're encrypted with
// everything else.

import { createStore } from '../ghsync/store.js';
import { createBlobStore } from './blobs.js';

export const APP_ID = 'homeinv'; // localStorage/IndexedDB namespace — unique on <you>.github.io

const files = {
  rooms: 'data/rooms.json',
  paints: 'data/paints.json',
  panels: 'data/panels.json',
  breakers: 'data/breakers.json',
  items: 'data/inventory.json',
  tasks: 'data/maintenance.json',
};

let blobStores = []; // filled right after the store; the hooks below only run later

// Breaker fixtures used to be plain strings; they're now { name, roomId }
// (roomId '' = all of the breaker's rooms). Old records convert on read and
// are saved in the new shape the next time they're written.
const fixtureOf = (f) => (typeof f === 'string' ? { name: f, roomId: '' } : f);
const migrateBreaker = (b) => (Array.isArray(b.fixtures) && b.fixtures.some((f) => typeof f === 'string')
  ? { ...b, fixtures: b.fixtures.map(fixtureOf) } : b);

export const store = createStore({
  appId: APP_ID,
  files,
  encrypted: Object.keys(files),
  encryptPath: (path) => blobStores.some((b) => b.owns(path)),
  migrate: { breakers: migrateBreaker },
  onRefresh: async () => {
    for (const b of blobStores) await b.mirror();
  },
});

export const photos = createBlobStore(store, { dbName: `${APP_ID}.photos`, dir: 'data/photos', kind: 'photos' });
export const docs = createBlobStore(store, { dbName: `${APP_ID}.files`, dir: 'data/files', kind: 'files' });
blobStores = [photos, docs];

export const pendingUploads = () => blobStores.reduce((n, b) => n + b.pending(), 0);
export function initBlobs() { for (const b of blobStores) b.init(); }

// The settings panel calls these two on the store object. Wrap them so
// attachments ride along: seeding a new repo uploads every local file, and a
// password change re-encrypts them. (pushAllData's internal call goes to the
// unwrapped rewriteEncryptedFiles, so nothing is pushed twice.)
const pushAllData = store.pushAllData;
store.pushAllData = async () => {
  await pushAllData();
  for (const b of blobStores) await b.pushAll(true);
};
const rewriteEncryptedFiles = store.rewriteEncryptedFiles;
store.rewriteEncryptedFiles = async (collections) => {
  await rewriteEncryptedFiles(collections);
  for (const b of blobStores) await b.pushAll(false);
};

// Convenience: stamp timestamps on every write.
export async function saveRecord(collection, record) {
  const stamp = new Date().toISOString();
  const rec = { ...record, updatedAt: stamp, createdAt: record.createdAt || stamp };
  await store.upsert(collection, rec);
  return rec;
}
