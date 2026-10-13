// Build ghsync.zip from the ghsync/ folder, for dropping into another repo.
// Run: node tools/pack-ghsync.mjs [out.zip]   (default: ./ghsync.zip, gitignored)
//
// No dependencies: a minimal zip writer (deflate + CRC from node:zlib). The
// archive holds a top-level ghsync/ folder, so unzipping at a repo root gives
// <root>/ghsync/store.js. Anything not tracked by git (node_modules, scratch
// files) is left out.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'ghsync.zip'));

// Tracked + new-but-not-ignored files under ghsync/.
const list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'ghsync'], { cwd: ROOT })
  .toString().split('\n').filter((f) => f && fs.existsSync(path.join(ROOT, f))).sort();

// DOS date/time for every entry: now.
const d = new Date();
const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

const locals = [];
const central = [];
let offset = 0;
for (const name of list) {
  const data = fs.readFileSync(path.join(ROOT, name));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const fname = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(dosTime, 10);
  head.writeUInt16LE(dosDate, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(comp.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(fname.length, 26);
  locals.push(head, fname, comp);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt16LE(dosTime, 12);
  cen.writeUInt16LE(dosDate, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(comp.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(fname.length, 28);
  cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  cen.writeUInt32LE(offset, 42);
  central.push(cen, fname);
  offset += head.length + fname.length + comp.length;
}
const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(list.length, 8);
end.writeUInt16LE(list.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(out, Buffer.concat([...locals, ...central, end]));
console.log(`${out}: ${list.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
