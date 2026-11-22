// End-to-end check of the plugin on a machine where its runtime can be installed.
//
//   node plugins/film-studio/dev/smoke.mjs [--keep] [--open]
//
// Starts `node server.mjs <a temporary project>` with the person's real XDG
// folders (so the real cache is used and filled), speaks JSON-RPC to it,
// installs what is missing, and goes through the tools: dashboard, guide,
// doctor, film_open (the editor is "opened" by a stand-in xdg-open that writes
// the address down, so nothing opens on Linux; on other systems film_open is
// skipped unless --open, which opens the real browser), a 3-second film with a
// local page, film_look, the refusal of a page that names a web font and a CDN
// script and the localize command that fixes it, film_render (0-2 s), and
// film_cancel. The editor is stopped at the end if this run started it.
// --keep leaves the temporary project in place. Exit status 0 when every check passed.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { OPENFILM_HOME } from '../lib/paths.mjs';
import { searchPath } from '../lib/runtime.mjs';

const keep = process.argv.includes('--keep');
const openForReal = process.argv.includes('--open');
const root = fileURLToPath(new URL('..', import.meta.url));
const say = (text) => console.log(text);
const step = (text) => say(`\n== ${text}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const minutes = (n) => n * 60_000;
const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- the project, and a stand-in browser opener

const project = realpathSync(mkdtempSync(join(tmpdir(), 'film-smoke-')));
const bin = join(project, '.bin');
const recorded = join(project, '.bin', 'opened.txt');
const standIn = process.platform === 'linux' && !openForReal;
let path = process.env.PATH;
if (standIn) {
  mkdirSync(bin);
  writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${recorded}'\n`);
  chmodSync(join(bin, 'xdg-open'), 0o755);
  path = `${bin}${delimiter}${process.env.PATH}`;
}
const editorBefore = (() => { const run = json(join(OPENFILM_HOME, 'run.json')); return Boolean(run?.pid && alive(run.pid)); })();

// ---------------------------------------------------------------- JSON-RPC

const child = spawn(process.execPath, ['server.mjs', project], { cwd: root, env: { ...process.env, PATH: path }, stdio: ['pipe', 'pipe', 'inherit'] });
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

/** The job an answer is about: Claude's tools say it in words. */
function jobIn(result) {
  assert.equal(result.structuredContent, undefined, 'an answer for Claude has structured content');
  const [, id, state] = textOf(result).match(/^job ([a-z]+-[0-9a-f]{6}) · (\w+)/) ?? assert.fail(textOf(result));
  return { id, state };
}
/** All there is to know of a job, as the page is told. */
const jobNow = async (id) => (await tool('film_dashboard')).structuredContent.jobs.find((job) => job.id === id);

/** Follow a job until it ends; prints its progress. */
async function follow(id, limit = minutes(15)) {
  const until = Date.now() + limit;
  let last = '';
  for (;;) {
    const result = await tool('film_job', { id, wait_seconds: 20 });
    const job = { ...jobIn(result), ...(await jobNow(id)) };
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


/** The clock page with something more in its head. */
const clockWith = (head) => CLOCK.replace('</head>', `${head}\n</head>`);
const FONT_AND_SCRIPT = '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
  + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">\n'
  + '<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>';

const indent = (text, n = 3) => text.split('\n').map((line) => `${' '.repeat(n)}${line}`).join('\n');
const images = (result) => result.content.filter((part) => part.type === 'image');

/** The one place the editor's address could leak to: everything a tool answered. */
function assertNoEditorAddress(result, address) {
  const everything = JSON.stringify(result);
  assert.ok(!/127\.0\.0\.1|localhost|https?:\/\//.test(everything), 'an address is in the answer');
  const run = json(join(OPENFILM_HOME, 'run.json'));
  for (const secret of [run?.key, ...(address ? [...new URL(address).searchParams.values(), new URL(address).port] : [])]) {
    if (secret && String(secret).length >= 4) assert.ok(!everything.includes(String(secret)), 'the editor\'s key or port is in the answer');
  }
}

let film = null;
let failed = false;
let startedEditor = false;
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
  const show = (d) => say(`   project ${d.project} · node ${d.node.version} · openfilm ${d.openfilm.version} installed=${d.openfilm.installed} · browser ${d.browser.version} installed=${d.browser.installed} · ffmpeg found=${d.ffmpeg.found} ${d.ffmpeg.version ?? ''} · memory ${d.memory.availableMB}/${d.memory.totalMB} MB`);
  show(dashboard);
  assert.equal(dashboard.project, project);
  assert.equal(dashboard.node.problem, null);
  assert.ok(!('terminal' in dashboard));
  assert.ok(!JSON.stringify(dashboard).includes('"key"'));

  if (!dashboard.openfilm.installed || !dashboard.browser.installed) {
    step('film_setup all');
    const setup = await tool('film_setup', { step: 'all' });
    say(textOf(setup).split('\n').slice(0, 3).map((line) => `   ${line}`).join('\n'));
    assert.ok(!setup.isError, 'film_setup failed to start');
    const job = await follow(jobIn(setup).id, minutes(20));
    for (const line of job.tail.slice(-8)) say(`   | ${line}`);
    dashboard = (await tool('film_dashboard')).structuredContent;
    show(dashboard);
    assert.ok(dashboard.openfilm.installed, 'OpenFilm is not installed after setup');
    assert.ok(dashboard.browser.installed, 'the render browser is not installed after setup');
  }
  assert.ok(dashboard.ffmpeg.found, `ffmpeg and ffprobe are needed on this computer; install them with: ${dashboard.setup.ffmpegCommand}`);

  step('film_guide');
  const guide = await tool('film_guide');
  assert.ok(!guide.isError, textOf(guide));
  say(textOf(guide).split('\n').slice(0, 6).map((line) => `   ${line}`).join('\n'));
  assert.match(textOf(guide), /film_look/);
  assert.match(textOf(guide), /network closed/);

  step('film_run doctor');
  const doctor = await tool('film_run', { args: ['doctor'], wait_seconds: 50 });
  say(indent(textOf(doctor)));
  const doctorJob = await follow(jobIn(doctor).id, minutes(3));
  // Exit status 1 is something to fix, such as WebGL drawn in software where there is no graphics chip: only
  // what the plugin installs must be there.
  const report = doctorJob.tail.join('\n');
  for (const what of ['OpenFilm', 'ffmpeg', 'ffprobe']) assert.match(report, new RegExp(`✓ ${what}\\s`), `doctor: ${what} is not right`);
  assert.match(report, /Browser\s+Chromium 149/, 'doctor: the render browser is not the pinned one');

  step('film_open "smoke film"');
  film = join(project, 'smoke film');
  if (!standIn && !openForReal) {
    say('   skipped (it would open the real browser; pass --open to try it)');
    mkdirSync(film, { recursive: true });
  } else {
    const opened = await tool('film_open', { folder: 'smoke film' });
    say(indent(textOf(opened)));
    assert.ok(!opened.isError, `film_open: ${textOf(opened)}`);
    startedEditor = !editorBefore;
    assert.ok(existsSync(film), 'the film folder was not made');
    let address = null;
    const alreadyOpen = /already open/.test(textOf(opened));
    if (standIn && !alreadyOpen) {
      for (let i = 0; i < 50 && !existsSync(recorded); i += 1) await sleep(100);
      assert.ok(existsSync(recorded), 'the editor was not opened in a browser');
      address = readFileSync(recorded, 'utf8').trim().split('\n').at(-1);
      say('   the browser was asked to open the editor (address not shown)');
      assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.match(textOf(opened), /The editor is open in the person's browser/);
    } else {
      say('   (the editor was already open, or the real browser is used: no address recorded)');
    }
    assert.equal(opened.structuredContent, undefined);
    assertNoEditorAddress(opened, address);
    assert.equal((await tool('film_dashboard')).structuredContent.studio.running, true);
  }

  step('make a 3-second film');
  writeFileSync(join(film, 'film.html'), FILM);
  writeFileSync(join(film, 'clock.html'), CLOCK);
  say(`   ${film}`);

  step('film_look at 1.5 s');
  const look = await tool('film_look', { folder: 'smoke film', at: ['1.5'] });
  say(indent(textOf(look).split('\n').slice(0, 12).join('\n')));
  say(`   ${images(look).length} image(s), ${look.isError ? 'error' : 'ok'}`);
  assert.ok(images(look).length >= 1, 'film_look returned no image');
  assert.ok(!/network closed/.test(textOf(look)), 'a local page was refused');

  step('film_thumbnail follows the pages');
  const picture = async () => {
    const made = await tool('film_thumbnail', { folder: 'smoke film' });
    assert.ok(!made.isError, textOf(made));
    assert.match(made.structuredContent.dataUrl, /^data:image\/jpeg;base64,/);
    return made.structuredContent.dataUrl;
  };
  const first = await picture();
  assert.equal(await picture(), first);
  await sleep(1100);
  writeFileSync(join(film, 'clock.html'), CLOCK.replaceAll('#101820', '#802020'));
  assert.notEqual(await picture(), first, 'the picture is of the film before its page changed');
  writeFileSync(join(film, 'clock.html'), CLOCK);
  say('   ok');

  step('film_look: a page naming a web font and a CDN script is refused, with the way out');
  writeFileSync(join(film, 'clock.html'), clockWith(FONT_AND_SCRIPT));
  const refused = await tool('film_look', { folder: 'smoke film', at: ['1.5'] });
  const refusedText = textOf(refused);
  say(indent(refusedText.split('\n').slice(0, 14).join('\n')));
  assert.match(refusedText, /request: csp https:\/\/fonts\.googleapis\.com\//);
  assert.match(refusedText, /request: csp https:\/\/cdn\.jsdelivr\.net\//);
  assert.match(refusedText, /network closed/);
  const command = refusedText.split('\n').find((line) => line.startsWith('node '));
  assert.ok(command, 'no command to run in the answer');
  assert.ok(command.includes('localize.mjs') && command.includes('smoke film'), command);
  assert.ok(!/127\.0\.0\.1|https?:\/\/(?!fonts\.|cdn\.)/.test(refusedText));
  assert.equal(readFileSync(join(film, '.film', 'film-studio', 'localize.mjs'), 'utf8'), readFileSync(join(root, 'lib', 'localize.mjs'), 'utf8'), 'the film\'s copy of localize.mjs differs');

  step('run localize on the film');
  const proxied = Object.keys(process.env).some((key) => /^https?_proxy$/i.test(key));
  const localized = spawnSync(process.execPath, [join(film, '.film', 'film-studio', 'localize.mjs'), film], {
    encoding: 'utf8', timeout: minutes(3), env: { ...process.env, ...(proxied ? { NODE_USE_ENV_PROXY: '1' } : {}) },
  });
  say(indent(`${localized.stdout}${localized.stderr}`.trim().split('\n').slice(-8).join('\n')));
  assert.equal(localized.status, 0, 'localize failed');
  const clock = readFileSync(join(film, 'clock.html'), 'utf8');
  assert.ok(!/https?:\/\//.test(clock), 'the page still names an address');
  assert.ok(!/preconnect/.test(clock));
  const vendored = json(join(film, 'assets', 'vendor', 'vendor.json'));
  assert.ok(vendored && Object.keys(vendored).some((key) => key.includes('gsap@3.12.5')) && Object.keys(vendored).some((key) => key.startsWith('https://fonts.googleapis.com/')), 'vendor.json lacks the font or gsap');
  assert.ok(Object.values(vendored).every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));

  step('film_look again passes');
  const again = await tool('film_look', { folder: 'smoke film', at: ['1.5'] });
  say(indent(textOf(again).split('\n').slice(0, 8).join('\n')));
  assert.ok(!/network closed|csp https|load only from their own folder/.test(textOf(again)), 'the page is still refused');
  assert.ok(images(again).length >= 1, 'film_look returned no image after localize');

  step('film_render 0-2 s');
  const render = await tool('film_render', { folder: 'smoke film', range: '0-2', wait_seconds: 55 });
  assert.ok(!render.isError, `film_render: ${textOf(render)}`);
  const rendered = await follow(jobIn(render).id, minutes(10));
  for (const line of rendered.tail.slice(-6)) say(`   | ${line}`);
  assert.equal(rendered.state, 'done', `render ended ${rendered.state}`);
  const video = rendered.outputs.find((file) => file.endsWith('.mp4'));
  assert.ok(video && existsSync(video), `no mp4 among ${JSON.stringify(rendered.outputs)}`);
  say(`   ${video} (${statSync(video).size} bytes)`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,duration', '-show_entries', 'format=duration', '-of', 'json', video], { encoding: 'utf8', env: { ...process.env, PATH: searchPath().join(delimiter) } });
  assert.equal(probe.status, 0, `ffprobe: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const videoStream = info.streams.find((stream) => stream.codec_type === 'video');
  const duration = Number(info.format.duration);
  say(`   ffprobe: ${videoStream?.codec_name}, ${duration} s`);
  assert.equal(videoStream?.codec_name, 'h264');
  assert.ok(Math.abs(duration - 2) < 0.3, `duration ${duration} is not about 2 s`);

  step('film_render a long one, then film_cancel');
  const started = await tool('film_render', { folder: 'smoke film', uhd: true, fps: 60, out: 'long.mp4', wait_seconds: 0 });
  assert.ok(!started.isError, `film_render: ${textOf(started)}`);
  const startedJob = jobIn(started);
  say(`   started ${startedJob.id} (${startedJob.state})`);
  assert.ok(['queued', 'running'].includes(startedJob.state), `the render was already ${startedJob.state}`);
  const cancelled = await tool('film_cancel', { id: startedJob.id });
  let job = jobIn(cancelled);
  for (let i = 0; i < 30 && job.state !== 'cancelled'; i++) {
    await sleep(500);
    job = jobIn(await tool('film_job', { id: startedJob.id, wait_seconds: 0 }));
  }
  say(`   ${job.id} ${job.state}`);
  assert.equal(job.state, 'cancelled');

  step('summary');
  say('   all checks passed');
} catch (error) {
  failed = true;
  console.error(`\nFAILED: ${error.stack || error}`);
} finally {
  // The editor, if this run started it: asked to quit with its own key (the key stays on this computer).
  const run = json(join(OPENFILM_HOME, 'run.json'));
  if (startedEditor && run?.pid && alive(run.pid)) {
    say('\nstopping the editor');
    try {
      await fetch(`${run.origin}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': run.key }, body: '{}', signal: AbortSignal.timeout(10_000) });
    } catch { /* it may close before it answers */ }
    for (let i = 0; i < 50 && alive(run.pid); i += 1) await sleep(200);
    if (alive(run.pid)) { say('   it did not quit; ending it'); try { process.kill(run.pid); } catch { /* gone */ } }
  } else if (editorBefore) {
    say('\nan editor was already running before this run: left as it is');
  }
  child.stdin.end();
  child.kill();
  await sleep(300);
  if (keep || failed) say(`\nthe project is kept at ${project}`);
  else rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
