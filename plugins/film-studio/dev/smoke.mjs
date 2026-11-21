// End-to-end check of the plugin on a machine where its runtime can be installed.
//
//   node plugins/film-studio/dev/smoke.mjs [--keep]
//
// Starts `node server.mjs` with the person's real XDG folders (so the real cache
// is used and filled), speaks JSON-RPC to it, installs what is missing, makes a
// 3-second film in a temporary folder, opens, looks at, renders (0-2 s) and
// cancels, and checks the results. --keep leaves the temporary film in place.
// Exit status 0 when every check passed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const keep = process.argv.includes('--keep');
const root = fileURLToPath(new URL('..', import.meta.url));
const say = (text) => console.log(text);
const step = (text) => say(`\n== ${text}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const minutes = (n) => n * 60_000;

// ---------------------------------------------------------------- JSON-RPC

const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});

function rpc(method, params, timeout = minutes(2)) {
  const id = nextId++;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeout);
    waiting.set(id, (message) => { clearTimeout(timer); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** Call a tool; returns its result and fails on a protocol error (not on isError). */
async function tool(name, args = {}) {
  const message = await rpc('tools/call', { name, arguments: args });
  assert.ok(!message.error, `${name}: ${JSON.stringify(message.error)}`);
  return message.result;
}
const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

/** Follow a job until it ends; prints its progress. */
async function follow(id, limit = minutes(15)) {
  const until = Date.now() + limit;
  let last = '';
  for (;;) {
    const result = await tool('film_job', { id, wait_seconds: 20 });
    const job = result.structuredContent.job;
    const progress = job.progress ? ` ${job.progress.done}/${job.progress.total} ${job.progress.unit}${job.progress.leftSeconds != null ? ` (~${job.progress.leftSeconds} s left)` : ''}` : '';
    const line = `   job ${job.id} ${job.state}${progress}`;
    if (line !== last) say(line);
    last = line;
    if (!['queued', 'running'].includes(job.state)) return job;
    assert.ok(Date.now() < until, `job ${id} did not finish in time`);
  }
}

// ---------------------------------------------------------------- the film

const FILM = '<meta name="viewport" content="width=640, height=360">\n<section>\n<iframe src="clock.html#t=0,3"></iframe>\n</section>\n';
const CLOCK = `<!doctype html><html><head><style>
  html, body { margin: 0; width: 640px; height: 360px; background: #101820; overflow: hidden }
  canvas { display: block }
</style></head><body>
<canvas id="c" width="640" height="360"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');
// The film format: a page that says how long it is and draws any moment on request.
window.film = {
  duration: 3,
  width: 640,
  height: 360,
  frame(t) {
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#4af';
    ctx.fillRect(40, 250, 560 * (t / 3), 30);
    ctx.fillStyle = '#fff';
    ctx.font = '600 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.toFixed(2) + ' s', 320, 160);
  },
};
</script></body></html>
`;

let folder = null;
let failed = false;
try {
  step('initialize');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  say(`   ${JSON.stringify(init.result.serverInfo)}`);
  assert.equal(init.result.serverInfo.name, 'film-studio');

  step('tools/list');
  const listed = (await rpc('tools/list', {})).result.tools;
  say(`   ${listed.map((entry) => entry.name).join(', ')}`);
  assert.ok(listed.length >= 10);

  step('film_dashboard');
  let dashboard = (await tool('film_dashboard')).structuredContent;
  const show = (d) => say(`   openfilm ${d.openfilm.version} installed=${d.openfilm.installed} · browser ${d.browser.version} installed=${d.browser.installed} · ffmpeg found=${d.ffmpeg.found} ${d.ffmpeg.version ?? ''} · sudo=${d.setup.sudo} · memory ${d.memory.availableMB}/${d.memory.totalMB} MB`);
  show(dashboard);

  if (!dashboard.openfilm.installed || !dashboard.browser.installed || !dashboard.ffmpeg.found) {
    step('film_setup all');
    const setup = await tool('film_setup', { step: 'all' });
    say(textOf(setup).split('\n').slice(0, 3).map((line) => `   ${line}`).join('\n'));
    assert.ok(!setup.isError, 'film_setup failed to start');
    const job = await follow(setup.structuredContent.job.id, minutes(20));
    for (const line of job.tail.slice(-8)) say(`   | ${line}`);
    dashboard = (await tool('film_dashboard')).structuredContent;
    show(dashboard);
    assert.ok(dashboard.openfilm.installed, 'OpenFilm is not installed after setup');
    assert.ok(dashboard.browser.installed, 'the render browser is not installed after setup');
    assert.ok(dashboard.ffmpeg.found, `ffmpeg is not installed after setup (${job.state}); run: ${dashboard.setup.ffmpegCommand}`);
  }

  step('film_run doctor');
  const doctor = await tool('film_run', { args: ['doctor'], wait_seconds: 50 });
  say(textOf(doctor).split('\n').map((line) => `   ${line}`).join('\n'));
  const doctorJob = ['queued', 'running'].includes(doctor.structuredContent.job.state) ? await follow(doctor.structuredContent.job.id, minutes(3)) : doctor.structuredContent.job;
  // Exit status 1 is something to fix, such as WebGL drawn in software where there is no graphics chip: only
  // what the plugin installs must be there.
  const report = doctorJob.tail.join('\n');
  for (const what of ['OpenFilm', 'ffmpeg', 'ffprobe']) assert.match(report, new RegExp(`✓ ${what}\\s`), `doctor: ${what} is not right`);
  assert.match(report, /Browser\s+Chromium 149/, 'doctor: the render browser is not the pinned one');

  step('make a 3-second film');
  folder = mkdtempSync(join(tmpdir(), 'film-smoke-'));
  writeFileSync(join(folder, 'film.html'), FILM);
  writeFileSync(join(folder, 'clock.html'), CLOCK);
  say(`   ${folder}`);

  step('film_open');
  const opened = await tool('film_open', { folder });
  say(textOf(opened).split('\n').map((line) => `   ${line}`).join('\n'));
  assert.ok(!opened.isError, 'film_open failed');
  assert.match(opened.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\//);

  step('film_look at 1.5 s');
  const look = await tool('film_look', { folder, at: ['1.5'] });
  say(textOf(look).split('\n').slice(0, 12).map((line) => `   ${line}`).join('\n'));
  const pictures = look.content.filter((part) => part.type === 'image');
  say(`   ${pictures.length} image(s), ${look.isError ? 'error' : 'ok'}`);
  assert.ok(pictures.length >= 1, 'film_look returned no image');

  step('film_render 0-2 s');
  const render = await tool('film_render', { folder, range: '0-2', wait_seconds: 55 });
  assert.ok(!render.isError, `film_render: ${textOf(render)}`);
  const rendered = ['queued', 'running'].includes(render.structuredContent.job.state)
    ? await follow(render.structuredContent.job.id, minutes(10)) : render.structuredContent.job;
  for (const line of rendered.tail.slice(-6)) say(`   | ${line}`);
  assert.equal(rendered.state, 'done', `render ended ${rendered.state}`);
  const video = rendered.outputs.find((path) => path.endsWith('.mp4'));
  assert.ok(video && existsSync(video), `no mp4 among ${JSON.stringify(rendered.outputs)}`);
  say(`   ${video} (${statSync(video).size} bytes)`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,duration', '-show_entries', 'format=duration', '-of', 'json', video], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `ffprobe: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const videoStream = info.streams.find((stream) => stream.codec_type === 'video');
  const duration = Number(info.format.duration);
  say(`   ffprobe: ${videoStream?.codec_name}, ${duration} s`);
  assert.equal(videoStream?.codec_name, 'h264');
  assert.ok(Math.abs(duration - 2) < 0.3, `duration ${duration} is not about 2 s`);

  step('film_run render, then film_cancel');
  const started = await tool('film_run', { args: ['render'], folder, wait_seconds: 0 });
  const startedJob = started.structuredContent.job;
  say(`   started ${startedJob.id} (${startedJob.state})`);
  assert.ok(['queued', 'running'].includes(startedJob.state), `the render was already ${startedJob.state}`);
  const cancelled = await tool('film_cancel', { id: startedJob.id });
  let job = cancelled.structuredContent.job;
  for (let i = 0; i < 20 && job.state !== 'cancelled'; i++) {
    await sleep(500);
    job = (await tool('film_job', { id: startedJob.id, wait_seconds: 0 })).structuredContent.job;
  }
  say(`   ${job.id} ${job.state}`);
  assert.equal(job.state, 'cancelled');

  step('summary');
  say('   all checks passed');
} catch (error) {
  failed = true;
  console.error(`\nFAILED: ${error.stack || error}`);
} finally {
  child.stdin.end();
  child.kill();
  if (folder) {
    if (keep || failed) say(`\nthe film is kept at ${folder}`);
    else rmSync(folder, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
