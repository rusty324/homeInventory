// The one ghsync store for the whole site, plus the photo side-store.
//
// Every collection is browser-owned and personal, so all are encrypted once a
// password is set. Photos are app-owned paths under data/photos/ (see
// photos.js), claimed by encryptPath so they're encrypted with everything else.

import { createStore } from '../ghsync/store.js';
import { createPhotos } from './photos.js';

const APP_ID = 'homeinv'; // localStorage/IndexedDB namespace — unique on <you>.github.io

const files = {
  rooms: 'data/rooms.json',
  paints: 'data/paints.json',
  panels: 'data/panels.json',
  breakers: 'data/breakers.json',
  items: 'data/inventory.json',
};

let photos; // created right after the store; the hook below only runs later

export const store = createStore({
  appId: APP_ID,
  files,
  encrypted: Object.keys(files),
  encryptPath: (path) => path.startsWith('data/photos/'),
  onRefresh: () => photos.mirror(),
});

photos = createPhotos(store, APP_ID);
export { photos };

// The settings panel calls these two on the store object. Wrap them so photo
// files ride along: seeding a new repo uploads every local photo, and a
// password change re-encrypts them. (pushAllData's internal call goes to the
// unwrapped rewriteEncryptedFiles, so photos aren't pushed twice.)
const pushAllData = store.pushAllData;
store.pushAllData = async () => {
  await pushAllData();
  await photos.pushAll(true);
};
const rewriteEncryptedFiles = store.rewriteEncryptedFiles;
store.rewriteEncryptedFiles = async (collections) => {
  await rewriteEncryptedFiles(collections);
  await photos.pushAll(false);
};

// Convenience: stamp timestamps on every write.
export async function saveRecord(collection, record) {
  const stamp = new Date().toISOString();
  const rec = { ...record, updatedAt: stamp, createdAt: record.createdAt || stamp };
  await store.upsert(collection, rec);
  return rec;
}
