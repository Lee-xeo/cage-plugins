import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { folderIn, sleep, until } from './helpers.mjs';

const { Jobs, progressOf, outputsOf, plain } = await import('../lib/jobs.mjs');
const { Refused } = await import('../lib/paths.mjs');

const fresh = () => {
  const root = folderIn('jobs');
  return { root, jobs: new Jobs({ root, environment: () => process.env }) };
};
/** A job that runs a node script. */
const node = (script, extra = {}) => ({ kind: 'command', title: 't', program: process.execPath, args: ['-e', script], cwd: folderIn('cwd'), ...extra });
const FOREVER = 'setInterval(() => {}, 1000)';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const running = (view) => ['queued', 'running'].includes(view.state);

/** Stop what a test started, so nothing outlives it. */
async function stopAll(jobs) {
  for (const { id } of jobs.ids()) jobs.cancel(id);
  await until(() => jobs.ids().every(({ meta }) => !['queued', 'running'].includes(jobs.state(meta))), 10000);
}

/** A job folder made by hand, as a runner leaves it. */
function handmade(root, id, { started, ran = started, code = null, aliveAt = null, ...rest }) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, kind: id.split('-')[0], title: id, program: 'x', args: [], cwd: root, folder: null, started, ran, ...rest }));
  writeFileSync(join(dir, 'out.log'), '');
  if (code !== null) writeFileSync(join(dir, 'exit.code'), `${code}\n`);
  if (aliveAt) { writeFileSync(join(dir, 'alive'), '1'); utimesSync(join(dir, 'alive'), aliveAt / 1000, aliveAt / 1000); }
  return dir;
}

test('plain strips colours and keeps the last carriage-return segment', () => {
  assert.equal(plain('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(plain('a\rb\rc\nd'), 'c\nd');
  assert.equal(plain('x\r\ny'), 'x\ny');
});

test('progressOf', () => {
  assert.deepEqual(progressOf('  rendering 90 frames with 1 browsers…'), { done: 0, total: 90, unit: 'frames', leftSeconds: null });
  assert.deepEqual(progressOf('  rendering 90 frames with 1 browsers…\n  45/90 frames · about 12 s left\n'), { done: 45, total: 90, unit: 'frames', leftSeconds: 12 });
  assert.deepEqual(progressOf('progress 3/21 packages\nprogress 4/21 packages'), { done: 4, total: 21, unit: 'packages', leftSeconds: null });
  assert.deepEqual(progressOf('progress 12.3/98.4 MB'), { done: 12.3, total: 98.4, unit: 'MB', leftSeconds: null });
  assert.deepEqual(progressOf('\x1b[2m  1/9 frames\r  2/9 frames · about 3 s left\x1b[0m'), { done: 2, total: 9, unit: 'frames', leftSeconds: 3 });
  assert.equal(progressOf('nothing here'), null);
});

test('outputsOf', () => {
  const [work, abs] = [resolve('/work/film'), resolve('/abs/x.png')];
  assert.deepEqual(outputsOf(`→ out.mp4\n  → ${abs}\n→ out.mp4\nno arrow\n`, work), [join(work, 'out.mp4'), abs]);
  assert.deepEqual(outputsOf('→ sub/a b.png  \n', work), [join(work, 'sub', 'a b.png')]);
  assert.deepEqual(outputsOf('', '/work/film'), []);
});

test('job ids are checked', () => {
  const { jobs } = fresh();
  for (const id of ['nope', '../x', 'a-b', 'command-ABCDEF', 'command-12345', undefined, 5, 'command-abcdef/../x']) assert.throws(() => jobs.folder(id), Refused);
  assert.equal(jobs.meta('command-abcdef'), null);
  assert.throws(() => jobs.view('command-abcdef'), Refused);
  assert.throws(() => jobs.cancel('command-abcdef'), Refused);
});

test('a film\'s job marks the film as shown when it starts, so OpenFilm does not open the editor itself', async () => {
  const { jobs } = fresh();
  const film = folderIn('film');
  const made = jobs.create(node("console.log(require('fs').existsSync('.film/opened'))", { cwd: film, folder: film }));
  const done = await jobs.wait(made.id, 20);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.tail, ['true']);
  const other = jobs.create(node('1', { cwd: folderIn('plain') }));
  assert.equal((await jobs.wait(other.id, 20)).state, 'done');
  assert.ok(!existsSync(join(jobs.meta(other.id).cwd, '.film')));
});

test('a job runs, ends done, lists its outputs and its log', async () => {
  const { jobs } = fresh();
  const made = jobs.create(node("console.log('hi'); console.log('→ out.txt'); console.log('→ gone.txt'); require('fs').writeFileSync('out.txt', 'x')"));
  assert.match(made.id, /^command-[0-9a-f]{6}$/);
  assert.ok(['queued', 'running', 'done'].includes(made.state));
  const done = await jobs.wait(made.id, 20);
  assert.equal(done.state, 'done');
  assert.equal(done.exitCode, 0);
  assert.deepEqual(done.outputs, [join(jobs.meta(made.id).cwd, 'out.txt')]);
  assert.ok(done.tail.includes('hi'));
  assert.ok(done.ended);
  assert.equal(done.progress, null);
  assert.equal(done.folder, null);
});

test('a failing job is failed with its exit code and its message', async () => {
  const { jobs } = fresh();
  const done = await jobs.wait(jobs.create(node("console.log('bad'); process.exit(3)")).id, 20);
  assert.equal(done.state, 'failed');
  assert.equal(done.exitCode, 3);
  assert.ok(done.tail.includes('bad'));
});

test('a missing program is failed with 127', async () => {
  const { jobs } = fresh();
  const done = await jobs.wait(jobs.create(node('', { program: join(folderIn('none'), 'no-such-program'), args: [] })).id, 20);
  assert.equal(done.state, 'failed');
  assert.equal(done.exitCode, 127);
  assert.ok(done.tail.length > 0);
});

test('a job in a folder that is not there is refused', () => {
  const { jobs } = fresh();
  assert.throws(() => jobs.create(node('', { cwd: join(folderIn('x'), 'missing') })), Refused);
});

test('tail keeps the last 30 lines and progress is read from the log', async () => {
  const { jobs } = fresh();
  const done = await jobs.wait(jobs.create(node("for (let i = 0; i < 100; i += 1) console.log('line ' + i); console.log('progress 3/4 packages')")).id, 20);
  assert.equal(done.tail.length, 30);
  assert.equal(done.tail.at(-1), 'progress 3/4 packages');
  assert.equal(done.tail[0], 'line 71');
  assert.equal(done.progress, null); // a finished job has none
});

test('a running job shows its progress', async () => {
  const { jobs } = fresh();
  const made = jobs.create(node(`console.log('progress 3/4 packages'); ${FOREVER}`));
  const seen = await until(() => { const v = jobs.view(made.id); return v.progress && v; });
  assert.deepEqual(seen.progress, { done: 3, total: 4, unit: 'packages', leftSeconds: null });
  assert.equal(seen.state, 'running');
  await stopAll(jobs);
});

test('cancel stops a long job and everything it started, within a few seconds', async () => {
  const { jobs } = fresh();
  const cwd = folderIn('cancel');
  const script = `const { spawn } = require('child_process');
    const kid = spawn(process.execPath, ['-e', ${JSON.stringify(FOREVER)}], { stdio: 'ignore' });
    require('fs').writeFileSync('kid.pid', String(kid.pid));
    console.log('started'); ${FOREVER}`;
  const made = jobs.create(node(script, { cwd }));
  const pid = Number(await until(() => existsSync(join(cwd, 'kid.pid')) && readFileSync(join(cwd, 'kid.pid'), 'utf8')));
  assert.ok(pid > 0);
  assert.ok(alive(pid));
  const began = Date.now();
  jobs.cancel(made.id);
  const end = await until(() => { const v = jobs.view(made.id); return !running(v) && v; }, 8000);
  assert.equal(end.state, 'cancelled');
  assert.ok(Date.now() - began < 8000);
  assert.equal(await until(() => !alive(pid), 4000), true, 'the job\'s own child is still running');
  // cancelling again changes nothing
  assert.equal(jobs.cancel(made.id).state, 'cancelled');
});

test('a render waits for the render before it, and starts by itself', async () => {
  const { jobs } = fresh();
  const render = (script) => jobs.create(node(script, { kind: 'render', title: 'r' }));
  const first = render(`console.log('first'); ${FOREVER}`);
  await until(() => jobs.view(first.id).tail.includes('first'));
  const second = render("console.log('second')");
  assert.equal(second.state, 'queued');
  assert.ok(second.tail.some((line) => /waiting/.test(line)));
  const third = render("console.log('third')");
  assert.equal(third.state, 'queued');
  // other kinds do not wait
  const other = await jobs.wait(jobs.create(node("console.log('other')")).id, 20);
  assert.equal(other.state, 'done');
  // a waiting one can be cancelled and then never starts
  const cancelled = jobs.cancel(second.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(jobs.view(second.id).exitCode, null);
  // the first ends: the third starts without anyone asking for it
  jobs.cancel(first.id);
  assert.equal((await jobs.wait(third.id, 25)).state, 'done');
  assert.equal(jobs.view(first.id).state, 'cancelled');
  assert.equal(jobs.view(second.id).state, 'cancelled');
  assert.ok(jobs.view(third.id).tail.includes('third'));
});

test('a new Jobs on the same folder finds a job that is running, and sees it end', async () => {
  const { root, jobs } = fresh();
  const made = jobs.create(node("setTimeout(() => console.log('late'), 1500)"));
  const again = new Jobs({ root, environment: () => process.env });
  assert.equal(again.view(made.id).state, 'running');
  assert.equal(again.list().length, 1);
  assert.equal(again.active('command')?.id, made.id);
  assert.equal(again.active('render'), null);
  const done = await again.wait(made.id, 20);
  assert.equal(done.state, 'done');
  assert.ok(done.tail.includes('late'));
  assert.equal(again.active('command'), null);
  // and one running can be cancelled from the new one
  const long = jobs.create(node(FOREVER));
  assert.equal(again.view(long.id).state, 'running');
  again.cancel(long.id);
  assert.equal(await until(() => again.view(long.id).state === 'cancelled', 8000), true);
});

test('a job whose runner is gone is stopped, and one that finished is not', () => {
  const { root, jobs } = fresh();
  const old = Date.now() - 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  handmade(root, 'command-aaaaaa', { started: iso(old) });
  assert.equal(jobs.view('command-aaaaaa').state, 'stopped');
  handmade(root, 'command-bbbbbb', { started: iso(old), aliveAt: old });
  assert.equal(jobs.view('command-bbbbbb').state, 'stopped');
  handmade(root, 'command-cccccc', { started: iso(old), aliveAt: Date.now() });
  assert.equal(jobs.view('command-cccccc').state, 'running');
  handmade(root, 'command-dddddd', { started: iso(Date.now()) });
  assert.equal(jobs.view('command-dddddd').state, 'running'); // only just started
  handmade(root, 'command-eeeeee', { started: iso(old), code: 0 });
  assert.equal(jobs.view('command-eeeeee').state, 'done');
  handmade(root, 'command-ffffff', { started: iso(old), code: 2 });
  assert.equal(jobs.view('command-ffffff').state, 'failed');
  handmade(root, 'command-abcdef', { started: iso(old), cancelled: true });
  assert.equal(jobs.view('command-abcdef').state, 'cancelled');
  handmade(root, 'render-123456', { started: iso(old), ran: null });
  assert.equal(jobs.state(jobs.meta('render-123456')), 'queued'); // (view would start it)
  // a stopped job is not a running one, so it does not hold a place or block the next render
  assert.equal(jobs.active('command')?.id === 'command-aaaaaa', false);
});

test('only the 32 newest finished jobs are kept; running ones are never forgotten', async () => {
  const { root, jobs } = fresh();
  const at = Date.now() - 3_600_000;
  for (let i = 0; i < 40; i += 1) {
    handmade(root, `command-${String(i).padStart(6, '0')}`, { started: new Date(at + i * 1000).toISOString(), code: 0 });
  }
  handmade(root, 'setup-0000ff', { started: new Date(at - 100_000).toISOString(), aliveAt: Date.now() });
  const made = jobs.create(node("console.log('new')"));
  const left = readdirSync(root).sort();
  assert.equal(left.length, 32 + 1 + 1);
  assert.ok(left.includes('setup-0000ff'));
  assert.ok(left.includes(made.id));
  for (let i = 0; i < 8; i += 1) assert.ok(!left.includes(`command-${String(i).padStart(6, '0')}`), `kept old ${i}`);
  for (let i = 8; i < 40; i += 1) assert.ok(left.includes(`command-${String(i).padStart(6, '0')}`), `lost ${i}`);
  await jobs.wait(made.id, 20);
});

test('at most 4 jobs at once, except renders, which queue', async () => {
  const { jobs } = fresh();
  try {
    for (let i = 0; i < 4; i += 1) jobs.create(node(FOREVER));
    assert.throws(() => jobs.create(node(FOREVER)), (error) => error instanceof Refused && /4 jobs/.test(error.message));
    const render = jobs.create(node("console.log('r')", { kind: 'render' }));
    assert.ok(['queued', 'running', 'done'].includes(render.state));
    // one finishing makes room
    const [first] = jobs.ids().filter(({ meta }) => meta.kind === 'command');
    jobs.cancel(first.id);
    await until(() => jobs.view(first.id).state === 'cancelled', 8000);
    assert.ok(jobs.create(node("console.log('fits')")).id);
  } finally {
    await stopAll(jobs);
  }
});

test('list(limit, mine) filters, orders newest first and limits', async () => {
  const { jobs } = fresh();
  const a = folderIn('a');
  const b = folderIn('b');
  const ids = [];
  for (const folder of [a, b, a]) {
    ids.push(jobs.create(node("console.log('x')", { folder })).id);
    await sleep(15);
  }
  await Promise.all(ids.map((id) => jobs.wait(id, 20)));
  assert.deepEqual(jobs.list().map((job) => job.id), [...ids].reverse());
  assert.deepEqual(jobs.list(12, (meta) => meta.folder === a).map((job) => job.id), [ids[2], ids[0]]);
  assert.deepEqual(jobs.list(12, (meta) => meta.folder === b).map((job) => job.id), [ids[1]]);
  assert.equal(jobs.list(2).length, 2);
  assert.equal(jobs.list(12, () => false).length, 0);
  assert.equal(jobs.list(12, (meta) => meta.folder === a)[0].folder, a);
});

test('the environment function decides what the job runs with', async () => {
  const root = folderIn('jobs');
  const jobs = new Jobs({ root, environment: (meta) => ({ ...process.env, FILM_TEST_AGENT: String(meta.agent) }) });
  const done = await jobs.wait(jobs.create(node('console.log(process.env.FILM_TEST_AGENT)', { agent: false })).id, 20);
  assert.ok(done.tail.includes('false'));
});
