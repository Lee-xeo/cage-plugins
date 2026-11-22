// Unpack a zip with Node alone, so it works the same on every system. Only
// plain files and folders: a link, or a path that leaves the folder, is refused.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Refused } from './refused.mjs';

const MOST = 1024 * 1024 * 1024;

export function unzip(file, into) {
  const zip = readFileSync(file);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Refused('the download is not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Refused('the zip file is damaged');
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const [nameLength, extraLength, noteLength] = [zip.readUInt16LE(at + 28), zip.readUInt16LE(at + 30), zip.readUInt16LE(at + 32)];
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const start = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + noteLength;
    const parts = name.split('/').filter(Boolean);
    if (!parts.length || name.startsWith('/') || /[\\:\0]/.test(name) || parts.includes('..')) throw new Refused(`the zip file holds an unexpected path ${JSON.stringify(name)}`);
    if ((mode & 0o170000) === 0o120000) throw new Refused(`the zip file holds a link ${JSON.stringify(name)}`);
    const path = join(into, ...parts);
    if (name.endsWith('/')) { mkdirSync(path, { recursive: true }); continue; }
    if ((total += size) > MOST) throw new Refused('the zip file is too large unpacked');
    const from = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
    const bytes = zip.subarray(from, from + packed);
    if (method !== 0 && method !== 8) throw new Refused('the zip file is packed in a way that is not supported');
    let data = bytes;
    if (method === 8) {
      try { data = inflateRawSync(bytes, { maxOutputLength: Math.max(size, 1) }); } catch { throw new Refused('the zip file is damaged'); }
    }
    if (data.length !== size) throw new Refused('the zip file is damaged');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    if (process.platform !== 'win32' && mode & 0o111) chmodSync(path, 0o755);
  }
}
