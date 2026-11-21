import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH } from './helpers.mjs';

const { matches, fetchPinned } = await import('../lib/download.mjs');
const { Refused } = await import('../lib/paths.mjs');

const dir = mkdtempSync(join(SCRATCH, 'dl-'));
const body = 'hello pinned world';
const sha256 = createHash('sha256').update(body).digest('hex');
const file = join(dir, 'f.bin');
writeFileSync(file, body);

test('matches checks size and SHA-256', () => {
  assert.equal(matches(file, { size: body.length, sha256 }), true);
  assert.equal(matches(file, { size: body.length + 1, sha256 }), false);
  assert.equal(matches(file, { size: body.length, sha256: 'a'.repeat(64) }), false);
  assert.equal(matches(join(dir, 'missing'), { size: 1, sha256 }), false);
});

test('fetchPinned refuses an invalid pin', async () => {
  const good = { urls: ['https://example.invalid/f'], size: 5, sha256 };
  await assert.rejects(fetchPinned({ ...good, sha256: 'nothex' }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({ ...good, sha256: 'A'.repeat(64) }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({ ...good, urls: [] }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({ ...good, urls: undefined }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({ ...good, size: 1.5 }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({ ...good, size: '5' }, join(dir, 'a')), Refused);
  await assert.rejects(fetchPinned({}, join(dir, 'a')), Refused);
});

test('fetchPinned returns without network when the file is already the pin', async () => {
  const said = [];
  const got = await fetchPinned({ urls: ['http://never.invalid/f'], size: body.length, sha256 }, file, (line) => said.push(line));
  assert.equal(got, file);
  assert.deepEqual(said, []);
});
