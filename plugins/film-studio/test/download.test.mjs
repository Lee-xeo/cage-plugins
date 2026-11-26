import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderIn } from './helpers.mjs';

const { matches, fetchPinned } = await import('../lib/download.mjs');
const { Refused } = await import('../lib/paths.mjs');

const dir = folderIn('dl');
const body = 'hello pinned world';
const sha256 = createHash('sha256').update(body).digest('hex');
const file = join(dir, 'f.bin');
writeFileSync(file, body);
const pin = { urls: ['https://example.invalid/f'], size: body.length, sha256 };

/** Run `work` with fetch replaced, and the waits between rounds made short. */
async function offline(answer, work) {
  const { fetch, setTimeout: wait } = globalThis;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return answer(url); };
  globalThis.setTimeout = (fn, ms, ...rest) => wait(fn, ms >= 1000 && ms <= 5000 ? 0 : ms, ...rest);
  try { await work(calls); } finally { Object.assign(globalThis, { fetch, setTimeout: wait }); }
}

test('matches checks size and SHA-256', () => {
  assert.equal(matches(file, { size: body.length, sha256 }), true);
  assert.equal(matches(file, { size: body.length + 1, sha256 }), false);
  assert.equal(matches(file, { size: body.length, sha256: 'a'.repeat(64) }), false);
  assert.equal(matches(join(dir, 'missing'), { size: 1, sha256 }), false);
});

test('fetchPinned refuses an invalid pin', async () => {
  for (const bad of [{ sha256: 'nothex' }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) }, { urls: [] }, { urls: undefined }, { urls: 'https://x/y' }, { size: 1.5 }, { size: '5' }, { size: undefined }]) {
    await assert.rejects(fetchPinned({ ...pin, ...bad }, join(dir, 'a')), Refused, JSON.stringify(bad));
  }
  await assert.rejects(fetchPinned({}, join(dir, 'a')), Refused);
  assert.ok(!existsSync(join(dir, 'a')));
});

test('fetchPinned returns without network when the file is already the pin', async () => {
  const said = [];
  await offline(() => { throw new Error('no network'); }, async (calls) => {
    const got = await fetchPinned({ ...pin, urls: ['http://never.invalid/f'] }, file, (line) => said.push(line));
    assert.equal(got, file);
    assert.equal(calls.length, 0);
  });
  assert.deepEqual(said, []);
});

test('fetchPinned skips an address that is not https', async () => {
  await offline(() => { throw new Error('no network'); }, async (calls) => {
    await assert.rejects(fetchPinned({ ...pin, urls: ['http://example.invalid/f', 'ftp://example.invalid/f', 'file:///etc/passwd'] }, join(dir, 'b')), Refused);
    assert.equal(calls.length, 0);
  });
  assert.ok(!existsSync(join(dir, 'b')));
});

test('fetchPinned fetches from the https address, checks it and keeps it', async () => {
  const dest = join(dir, 'sub', 'c.bin');
  await offline(() => new Response(body), async (calls) => {
    const said = [];
    assert.equal(await fetchPinned({ ...pin, urls: ['http://example.invalid/f', 'https://example.invalid/f'] }, dest, (line) => said.push(line)), dest);
    assert.deepEqual(calls.map((call) => call.url), ['https://example.invalid/f']);
    assert.ok(said.some((line) => /^progress /.test(line)));
  });
  assert.equal(readFileSync(dest, 'utf8'), body);
  assert.ok(!existsSync(`${dest}.part`));
});

test('fetchPinned refuses a download that is not the pinned file, and keeps nothing', async () => {
  for (const [answer, name] of [[body.replace('h', 'j'), 'other bytes'], [`${body}!`, 'larger'], [body.slice(1), 'smaller']]) {
    const dest = join(dir, `d-${name.replace(' ', '-')}`);
    await offline(() => new Response(answer), async (calls) => {
      await assert.rejects(fetchPinned(pin, dest), Refused, name);
      assert.equal(calls.length, 1, `${name}: a refused file is not asked for again`);
    });
    assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`), name);
  }
});

test('fetchPinned tries three rounds, then says it failed', async () => {
  const dest = join(dir, 'e.bin');
  await offline(() => new Response('', { status: 503 }), async (calls) => {
    await assert.rejects(fetchPinned({ ...pin, urls: ['https://a.invalid/f', 'https://b.invalid/f'] }, dest), (error) => error instanceof Refused && /HTTP 503/.test(error.message));
    assert.equal(calls.length, 6);
  });
  await offline(() => { throw new Error('boom'); }, async (calls) => {
    await assert.rejects(fetchPinned(pin, dest), /boom/);
    assert.equal(calls.length, 3);
  });
  assert.ok(!existsSync(dest));
});
