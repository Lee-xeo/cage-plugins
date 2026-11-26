import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { folderIn } from './helpers.mjs';

const { unzip } = await import('../lib/zip.mjs');
const { Refused } = await import('../lib/paths.mjs');

/**
 * A zip made by hand. Each entry: { name, data, method: 0 stored | 8 deflated, mode, size (the size it claims) }.
 * A name ending in / is a folder.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 0;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const size = entry.size ?? data.length;
    const crc = crc32 ? crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function attempt(entries, { cut } = {}) {
  const dir = folderIn('zip');
  const file = join(dir, 'a.zip');
  const into = join(dir, 'into');
  mkdirSync(into);
  const bytes = makeZip(entries);
  writeFileSync(file, cut ? bytes.subarray(0, cut(bytes.length)) : bytes);
  return { dir, into, run: () => unzip(file, into) };
}
const files = (dir) => readdirSync(dir, { recursive: true });

test('a good zip unpacks, stored and deflated, with modes', () => {
  const text = 'hello hello hello hello '.repeat(20);
  const { into, run } = attempt([
    { name: 'top/', data: '' },
    { name: 'top/a.txt', data: text, method: 8 },
    { name: 'top/bin/run', data: '#!/bin/sh\n', method: 0, mode: 0o100755 },
    { name: 'top/empty.txt', data: '', method: 0 },
    { name: 'top/deep/er/b.bin', data: Buffer.from([0, 1, 2, 255]), method: 8 },
  ]);
  run();
  assert.equal(readFileSync(join(into, 'top', 'a.txt'), 'utf8'), text);
  assert.equal(readFileSync(join(into, 'top', 'bin', 'run'), 'utf8'), '#!/bin/sh\n');
  assert.equal(statSync(join(into, 'top', 'empty.txt')).size, 0);
  assert.deepEqual([...readFileSync(join(into, 'top', 'deep', 'er', 'b.bin'))], [0, 1, 2, 255]);
  if (process.platform !== 'win32') {
    assert.ok(statSync(join(into, 'top', 'bin', 'run')).mode & 0o100);
    assert.equal(statSync(join(into, 'top', 'a.txt')).mode & 0o111, 0);
  }
});

test('a zip with a path that leaves the folder, or is not plain, is refused and writes nothing outside', () => {
  for (const name of ['../x', 'a/../../x', '/abs/x', 'a\\b', 'C:x', 'a/../b', '..']) {
    const { dir, into, run } = attempt([{ name, data: 'x' }]);
    assert.throws(run, Refused, name);
    assert.ok(!existsSync(join(dir, 'x')), name);
    assert.deepEqual(files(dir).filter((f) => f !== 'a.zip' && f !== 'into'), [], name);
    assert.deepEqual(files(into), [], name);
  }
});

test('a zip with a link is refused', () => {
  const { run } = attempt([{ name: 'l', data: '/etc/passwd', mode: 0o120777 }]);
  assert.throws(run, /link/);
});

test('a truncated or damaged zip is refused', () => {
  const entries = [{ name: 'a.txt', data: 'abcdef', method: 8 }, { name: 'b.txt', data: 'x'.repeat(100), method: 8 }];
  assert.throws(attempt(entries, { cut: (n) => n - 10 }).run, Refused);
  assert.throws(attempt(entries, { cut: (n) => Math.floor(n / 2) }).run, Refused);
  assert.throws(attempt(entries, { cut: () => 10 }).run, Refused);
  assert.throws(attempt([], { cut: () => 0 }).run, Refused);
  // central directory damaged
  const dir = folderIn('zip');
  const bytes = makeZip(entries);
  bytes.writeUInt32LE(0, bytes.readUInt32LE(bytes.length - 6));
  writeFileSync(join(dir, 'a.zip'), bytes);
  assert.throws(() => unzip(join(dir, 'a.zip'), join(dir, 'into')), /damaged/);
});

test('a zip whose sizes are wrong is refused', () => {
  assert.throws(attempt([{ name: 'a', data: 'abcdef', method: 0, size: 3 }]).run, /damaged/);
  assert.throws(attempt([{ name: 'a', data: 'abcdef', method: 0, size: 9 }]).run, /damaged/);
  assert.throws(attempt([{ name: 'a', data: 'abcdef', method: 8, size: 9 }]).run, /damaged/);
  assert.throws(attempt([{ name: 'a', data: 'abcdef', method: 8, size: 3 }]).run, /damaged/);
  // claims less than it holds: not unpacked either (some error, ideally a Refused)
  assert.throws(attempt([{ name: 'a', data: 'abcdef'.repeat(50), method: 8, size: 3 }]).run);
  assert.throws(attempt([{ name: 'a', data: 'abc', method: 9 }]).run, /not supported/);
});
