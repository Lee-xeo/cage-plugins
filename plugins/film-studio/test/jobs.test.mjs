import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH } from './helpers.mjs';

const { Jobs, progressOf, outputsOf, plain } = await import('../lib/jobs.mjs');
const { Refused } = await import('../lib/paths.mjs');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const fresh = () => {
  const root = mkdtempSync(join(SCRATCH, 'jobs-'));
  return { root, jobs: new Jobs({ root, environment: () => process.env }) };
};
const cwdOf = () => realpathSync(mkdtempSync(join(SCRATCH, 'cwd-')));
const sh = (script) => ({ program: '/bin/sh', args: ['-c', script] });

test('plain strips colours and keeps the last carriage-return segment', () => {
  assert.equal(plain('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(plain('a\rb\rc\nd'), 'c\nd');
  assert.equal(plain('x\r\ny'), 'x\ny');
});

test('progressOf', () => {
  assert.deepEqual(progressOf('  rendering 90 frames with 1 browsers…'), { done: 0, total: 90, unit: 'frames', leftSeconds: null });
  assert.deepEqual(progressOf('  rendering 90 frames with 1 browsers…\n  45/90 frames · about 12 s left\n'),
    { done: 45, total: 90, unit: 'frames', leftSeconds: 12 });
  assert.deepEqual(progressOf('  45/90 frames'), { done: 45, total: 90, unit: 'frames', leftSeconds: null });
  assert.deepEqual(progressOf('progress 3/21 packages\nprogress 4/21 packages'), { done: 4, total: 21, unit: 'packages', leftSeconds: null });
  assert.deepEqual(progressOf('progress 12.3/98.4 MB'), { done: 12.3, total: 98.4, unit: 'MB', leftSeconds: null });
  assert.deepEqual(progressOf('\x1b[2m  1/9 frames\r  2/9 frames · about 3 s left\x1b[0m'), { done: 2, total: 9, unit: 'frames', leftSeconds: 3 });
  assert.equal(progressOf('nothing here'), null);
});

test('outputsOf', () => {
  const cwd = '/work/film';
  assert.deepEqual(outputsOf('→ out.mp4\n  → /abs/x.png\n→ out.mp4\nno arrow\n', cwd), ['/work/film/out.mp4', '/abs/x.png']);
  assert.deepEqual(outputsOf('→ sub/a b.png  \n', cwd), ['/work/film/sub/a b.png']);
  assert.deepEqual(outputsOf('', cwd), []);
});

test('a job runs, ends done, lists its outputs and its log', async () => {
  const { jobs } = fresh();
  const cwd = cwdOf();
  const made = jobs.create({ kind: 'command', title: 't', ...sh('echo hi; echo "→ out.txt"; touch out.txt'), cwd });
  assert.match(made.id, /^command-[0-9a-f]{6}$/);
  const done = await jobs.wait(made.id, 20);
  assert.equal(done.state, 'done');
  assert.equal(done.exitCode, 0);
  assert.deepEqual(done.outputs, [join(cwd, 'out.txt')]);
  assert.ok(done.tail.includes('hi'));
  assert.ok(done.ended);
  assert.equal(done.progress, null);
});

test('an output that does not exist is not listed', async () => {
  const { jobs } = fresh();
  const made = jobs.create({ kind: 'command', title: 't', ...sh('echo "→ missing.txt"'), cwd: cwdOf() });
  assert.deepEqual((await jobs.wait(made.id, 20)).outputs, []);
});

test('a failing job is failed with its exit code', async () => {
  const { jobs } = fresh();
  const made = jobs.create({ kind: 'command', title: 't', ...sh('echo bad; exit 3'), cwd: cwdOf() });
  const done = await jobs.wait(made.id, 20);
  assert.equal(done.state, 'failed');
  assert.equal(done.exitCode, 3);
});

test('a missing program is failed with 127', async () => {
  const { jobs } = fresh();
  const made = jobs.create({ kind: 'command', title: 't', program: '/no/such/program', args: [], cwd: cwdOf() });
  const done = await jobs.wait(made.id, 20);
  assert.equal(done.state, 'failed');
  assert.equal(done.exitCode, 127);
});

test('cancel stops a running job within a few seconds', async () => {
  const { jobs } = fresh();
  const made = jobs.create({ kind: 'command', title: 't', ...sh('sleep 30'), cwd: cwdOf() });
  await sleep(300);
  assert.equal(jobs.view(made.id).state, 'running');
  const t0 = Date.now();
  jobs.cancel(made.id);
  let view = jobs.view(made.id);
  while (view.state !== 'cancelled' && Date.now() - t0 < 6000) { await sleep(200); view = jobs.view(made.id); }
  assert.equal(view.state, 'cancelled');
  assert.ok(Date.now() - t0 < 6000);
});

test('create refuses a missing folder; unknown ids are refused', () => {
  const { jobs } = fresh();
  assert.throws(() => jobs.create({ kind: 'command', title: 't', ...sh('true'), cwd: '/no/such/dir' }), Refused);
  assert.throws(() => jobs.view('nope'), Refused);
  assert.throws(() => jobs.view('command-zzzzzz'), Refused);
  assert.throws(() => jobs.view('../../etc'), Refused);
  assert.throws(() => jobs.cancel('command-abcdef'), Refused);
});

test('a second render waits for the first and then starts', async () => {
  const { jobs } = fresh();
  const cwd = cwdOf();
  const first = jobs.create({ kind: 'render', title: 'a', ...sh('sleep 2; echo first'), cwd });
  const second = jobs.create({ kind: 'render', title: 'b', ...sh('echo second'), cwd });
  assert.equal(first.state, 'running');
  assert.equal(second.state, 'queued');
  assert.equal(jobs.view(second.id).state, 'queued');
  const done = await jobs.wait(second.id, 30);
  assert.equal(done.state, 'done');
  assert.ok(done.tail.includes('second'));
  assert.equal(jobs.view(first.id).state, 'done');
});

test('a queued render can be cancelled and never starts', async () => {
  const { jobs } = fresh();
  const cwd = cwdOf();
  jobs.create({ kind: 'render', title: 'a', ...sh('sleep 1'), cwd });
  const second = jobs.create({ kind: 'render', title: 'b', ...sh('echo second'), cwd });
  assert.equal(jobs.cancel(second.id).state, 'cancelled');
  await sleep(1800);
  assert.equal(jobs.view(second.id).state, 'cancelled');
  assert.ok(!jobs.view(second.id).tail.includes('second'));
});

test('a new Jobs on the same root sees the same jobs (re-attach)', async () => {
  const { root, jobs } = fresh();
  const made = jobs.create({ kind: 'command', title: 'long', ...sh('sleep 2; echo end'), cwd: cwdOf() });
  const other = new Jobs({ root, environment: () => process.env });
  assert.equal(other.view(made.id).state, 'running');
  assert.equal(other.list().length, 1);
  assert.equal(other.active('command')?.id, made.id);
  const done = await other.wait(made.id, 30);
  assert.equal(done.state, 'done');
  assert.equal(jobs.view(made.id).state, 'done');
  assert.equal(other.active('command'), null);
});

test('prune keeps the 32 newest finished jobs', () => {
  const { root, jobs } = fresh();
  for (let i = 0; i < 40; i++) {
    const id = `command-${i.toString(16).padStart(6, '0')}`;
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, kind: 'command', title: 't', pid: null, started: new Date(1e12 + i * 1000).toISOString() }));
    writeFileSync(join(root, id, 'out.log'), '');
    writeFileSync(join(root, id, 'exit.code'), '0\n');
  }
  assert.equal(jobs.ids().length, 40);
  jobs.prune();
  const left = jobs.ids().map((entry) => entry.id);
  assert.equal(left.length, 32);
  assert.ok(existsSync(join(root, 'command-000027')));
  assert.ok(!existsSync(join(root, 'command-000000')));
  assert.ok(left.includes('command-000027') && !left.includes('command-000007'));
});

test('no more than four non-render jobs at once', () => {
  const { jobs } = fresh();
  const cwd = cwdOf();
  const made = [];
  for (let i = 0; i < 4; i++) made.push(jobs.create({ kind: 'command', title: 't', ...sh('sleep 5'), cwd }));
  assert.throws(() => jobs.create({ kind: 'command', title: 't', ...sh('true'), cwd }), /already running/);
  for (const job of made) jobs.cancel(job.id);
});
