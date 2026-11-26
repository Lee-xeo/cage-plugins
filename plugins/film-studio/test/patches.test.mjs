import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderIn } from './helpers.mjs';

const { PATCHES, PATCHES_DIGEST, POLICY, applyPatches } = await import('../lib/patches.mjs');
const { Refused } = await import('../lib/paths.mjs');

const sources = (extra = {}) => PATCHES.map((patch, i) => `// part ${i}\n${patch.find}\n`).join('\n').concat(extra.tail ?? '');

function fake(text = sources(), file = 'src/host.mjs') {
  const folder = folderIn('pkg');
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, file), text);
  return { folder, file: join(folder, file) };
}

test('every change finds its text once in the fake package', () => {
  for (const { file, find } of PATCHES) assert.equal(file, 'src/host.mjs');
  for (const { find } of PATCHES) assert.equal(sources().split(find).length, 2, find);
});

test('all changes are made', () => {
  const { folder, file } = fake();
  applyPatches(folder);
  const after = readFileSync(file, 'utf8');
  for (const { find, put } of PATCHES) {
    assert.ok(after.includes(put), put.slice(0, 60));
    assert.ok(!after.includes(find) || put.includes(find), find);
  }
  assert.ok(after.includes('offline = true'));
  assert.ok(after.includes(JSON.stringify(POLICY).slice(1, 40)));
  assert.deepEqual(readdirSync(join(folder, 'src')), ['host.mjs']);
});

test('a text that is missing refuses everything and leaves the file as it was', () => {
  for (let i = 0; i < PATCHES.length; i += 1) {
    const text = sources().replace(PATCHES[i].find, 'something else');
    const { folder, file } = fake(text);
    assert.throws(() => applyPatches(folder), Refused, `patch ${i}`);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.deepEqual(readdirSync(join(folder, 'src')), ['host.mjs']);
  }
});

test('a text that is there twice refuses everything and leaves the file as it was', () => {
  for (let i = 0; i < PATCHES.length; i += 1) {
    const text = sources({ tail: `\n${PATCHES[i].find}\n` });
    const { folder, file } = fake(text);
    assert.throws(() => applyPatches(folder), Refused, `patch ${i}`);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('a missing file is an error and nothing else is made', () => {
  const folder = folderIn('pkg');
  assert.throws(() => applyPatches(folder));
});

test('applying twice is refused', () => {
  const { folder, file } = fake();
  applyPatches(folder);
  const once = readFileSync(file, 'utf8');
  assert.throws(() => applyPatches(folder), Refused);
  assert.equal(readFileSync(file, 'utf8'), once);
});

test('CRLF input is handled', () => {
  const { folder, file } = fake(sources().replaceAll('\n', '\r\n'));
  applyPatches(folder);
  const after = readFileSync(file, 'utf8');
  assert.ok(!after.includes('\r'));
  for (const { put } of PATCHES) assert.ok(after.includes(put));
});

test('the digest and the policy', () => {
  assert.match(PATCHES_DIGEST, /^[0-9a-f]{8}$/);
  assert.ok(POLICY.includes("connect-src 'self'"));
  assert.match(POLICY, /(^|; )sandbox( |;|$)/);
  assert.ok(POLICY.includes("default-src 'self'"));
  assert.ok(!/https?:|\*/.test(POLICY));
});
