import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, SCRATCH, folderIn, until } from './helpers.mjs';

const { JOBS, OPENFILM_HOME, DATA } = await import('../lib/paths.mjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const toolsJson = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const project = join(folderIn('project'), 'my films');
mkdirSync(join(project, 'a'), { recursive: true });
writeFileSync(join(project, 'a', 'film.html'), '<p>no addresses here</p>\n');

// no network, whatever a test starts by mistake
const env = { ...process.env, ...ENV, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
let child;
const waiting = new Map();
let next = 1;

before(() => {
  child = spawn(process.execPath, ['server.mjs', project], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
});
after(() => { child.stdin.end(); child.kill(); });

function rpc(method, params) {
  const id = next++;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 20000);
    waiting.set(id, (message) => { clearTimeout(timer); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args }));
const textOf = (message) => message.result.content.map((part) => part.text ?? '').join('\n');
const refused = async (name, args, pattern) => {
  const message = await tool(name, args);
  assert.equal(message.result?.isError, true, `${name} ${JSON.stringify(args)}: ${JSON.stringify(message)}`);
  if (pattern) assert.match(textOf(message), pattern, `${name} ${JSON.stringify(args)}`);
  return textOf(message);
};

test('without a project folder the server stops, with a message', () => {
  for (const args of [[], ['relative/folder'], ['']]) {
    const run = spawnSync(process.execPath, ['server.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000, input: '' });
    assert.equal(run.status, 1, `args ${JSON.stringify(args)}`);
    assert.match(run.stderr, /project folder/);
    assert.equal(run.stdout, '');
  }
});

test('initialize echoes the protocol version and names the server', async () => {
  const { result } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.equal(result.serverInfo.name, 'film-studio');
  assert.equal(result.serverInfo.version, manifest.version);
  assert.ok(result.capabilities.tools);
  assert.equal(typeof result.instructions, 'string');
  assert.equal((await rpc('initialize', {})).result.protocolVersion, '2025-06-18');
});

test('tools/list is tools.json, and every tool has a handler or is refused cleanly', async () => {
  const { result } = await rpc('tools/list', {});
  assert.deepEqual(result.tools, toolsJson);
  assert.deepEqual(result.tools.map((entry) => entry.name).sort(), ['film_cancel', 'film_dashboard', 'film_guide', 'film_job', 'film_localize', 'film_look', 'film_open',
    'film_render', 'film_run', 'film_setup', 'film_studio', 'film_thumbnail']);
  for (const entry of result.tools) assert.equal(entry.inputSchema.type, 'object', entry.name);
  for (const gone of ['film_terminal', 'film_url']) assert.ok(!result.tools.some((entry) => entry.name === gone));
});

test('ping, unknown method, unknown tool', async () => {
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal((await rpc('nothing/here')).error.code, -32601);
  assert.equal((await tool('film_nope')).error.code, -32602);
  assert.equal((await tool('constructor')).error.code, -32602);
  assert.equal((await tool('__proto__')).error.code, -32602);
  assert.equal((await rpc('tools/call', {})).error.code, -32602);
  assert.equal((await rpc('tools/call')).error.code, -32602);
});

test('film_open refuses what is outside the project, hidden, or not given', async () => {
  const outside = folderIn('elsewhere');
  await refused('film_open', { folder: '../x' }, /inside the project/);
  await refused('film_open', { folder: '../../../etc' }, /inside the project/);
  await refused('film_open', { folder: outside }, /inside the project/);
  await refused('film_open', { folder: '/etc' }, /inside the project/);
  await refused('film_open', { folder: '~/x' }, /inside the project/);
  await refused('film_open', { folder: '//host/share' }, /inside the project/);
  await refused('film_open', { folder: '.hidden' }, /hidden/);
  await refused('film_open', { folder: 'a/.film' }, /hidden/);
  await refused('film_open', {}, /folder is required/);
  await refused('film_open', { folder: 5 }, /folder is required/);
  await refused('film_open', { folder: 'x\0y' }, /character/);
  await refused('film_studio', { folder: '../x' }, /inside the project/);
  await refused('film_studio', {}, /folder is required/);
  // the answer says the project's own spelling, not a path of this computer's other than that
  assert.ok(!(await refused('film_open', { folder: '../x' })).includes(SCRATCH.replace(/\/$/, '') + '/../'));
});

test('film_run, film_look, film_render, film_thumbnail and film_localize refuse before anything is installed', async () => {
  await refused('film_run', { args: ['update'] }, /kept at/);
  await refused('film_run', { args: ['open'] }, /film_open/);
  await refused('film_run', { args: ['look'] }, /film_look/);
  await refused('film_run', { args: ['render'] }, /film_render/);
  await refused('film_run', { args: ['publish'] }, /cannot be run/);
  await refused('film_run', { args: ['skill', 'add'] });
  await refused('film_run', { args: [] }, /list of words/);
  await refused('film_run', { args: 'doctor' }, /list of words/);
  await refused('film_run', {}, /list of words/);
  await refused('film_run', { args: ['get', 'tts'] }, /folder is required/);
  await refused('film_run', { args: ['get', 'web-fetch', 'https://example.com'], folder: 'a' }, /cannot be run/);
  await refused('film_run', { args: ['get', 'image', 'https://example.com/x.png'], folder: 'a' }, /files of the project only/);
  await refused('film_run', { args: ['edit', 'add', '/etc/passwd'], folder: 'a' }, /inside the project/);
  await refused('film_run', { args: ['doctor'], folder: '../x' }, /inside the project/);
  await refused('film_run', { args: ['doctor'], folder: 'nothing-here' }, /no film\.html/);
  await refused('film_look', { folder: 'nothing-here' }, /no film\.html/);
  await refused('film_look', { folder: '../x' }, /inside the project/);
  await refused('film_look', { folder: 'a', what: '../../etc/passwd' }, /inside the project/);
  await refused('film_look', { folder: 'a', count: 0 });
  await refused('film_render', { folder: 'a', out: '../../x.mp4' }, /inside the project/);
  await refused('film_render', { folder: 'a', out: 'x.txt' }, /video file/);
  await refused('film_render', { folder: 'a', loudness: 'loud' });
  await refused('film_render', { folder: 'a', range: '1' }, /stretch/);
  await refused('film_render', { folder: 'nothing-here' }, /no film\.html/);
  await refused('film_localize', { folder: 'nothing-here' }, /no film\.html/);
  await refused('film_localize', { folder: '../x' }, /inside the project/);
  await refused('film_thumbnail', { folder: 'a' }, /not installed/);
  await refused('film_setup', { step: 'bogus' }, /all, openfilm or browser/);
  await refused('film_setup', {}, /all, openfilm or browser/);
});

test('film_job and film_cancel with an id that is not a job', async () => {
  for (const id of ['nope', 'render-abcdef', '../x', undefined, 5]) {
    await refused('film_job', { id }, /no job/);
    await refused('film_cancel', { id }, /no job/);
  }
});

test('film_localize makes a job of the project\'s film, which film_job follows', async () => {
  const started = await tool('film_localize', { folder: 'a' });
  assert.ok(!started.result.isError, textOf(started));
  const id = textOf(started).match(/^job (command-[0-9a-f]{6}) /)?.[1];
  assert.ok(id, textOf(started));
  const done = await until(async () => {
    const { result } = await tool('film_job', { id, wait_seconds: 5 });
    assert.equal(result.structuredContent, undefined, 'Claude is told in words');
    return result.content[0].text.includes(`job ${id} · done`) && (await tool('film_dashboard')).result.structuredContent.jobs.find((job) => job.id === id);
  }, 20000);
  assert.ok(done, 'the job did not finish');
  assert.ok(done.tail.some((line) => /0 files/.test(line)), done.tail.join('\n'));
  assert.equal(done.exitCode, 0);
  assert.equal(done.folder, join(project, 'a'));
});

test('film_dashboard has the contract\'s shape and no address or key of the editor', async () => {
  mkdirSync(OPENFILM_HOME, { recursive: true });
  writeFileSync(join(OPENFILM_HOME, 'run.json'), JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:45678', key: 'SECRETKEY-7f3a9' }));
  writeFileSync(join(DATA, 'state.json'), JSON.stringify({ lastOpened: { folder: join(project, 'a'), at: '2026-01-01T00:00:00.000Z' } }));
  const message = await tool('film_dashboard');
  assert.ok(!message.result.isError, textOf(message));
  const d = message.result.structuredContent;
  assert.deepEqual(Object.keys(d).sort(), ['browser', 'ffmpeg', 'films', 'jobs', 'lastOpened', 'memory', 'node', 'openfilm', 'plugin', 'project', 'setup', 'studio'].sort());
  assert.equal(d.plugin, manifest.version);
  assert.equal(d.project, project);
  assert.deepEqual(Object.keys(d.node).sort(), ['problem', 'version']);
  assert.equal(d.node.version, process.versions.node);
  assert.equal(d.node.problem, null);
  assert.equal(d.openfilm.installed, false);
  assert.equal(typeof d.openfilm.version, 'string');
  assert.equal(d.browser.installed, false);
  assert.equal(typeof d.browser.version, 'string');
  assert.equal(typeof d.ffmpeg.found, 'boolean');
  assert.ok('totalMB' in d.memory && 'availableMB' in d.memory);
  assert.deepEqual(Object.keys(d.setup).sort(), ['downloadMB', 'ffmpegCommand']);
  assert.equal(d.setup.ffmpegCommand, { win32: 'winget install --id Gyan.FFmpeg -e', darwin: 'brew install ffmpeg' }[process.platform] ?? 'sudo apt-get install -y ffmpeg');
  assert.deepEqual(d.studio, { running: true });
  assert.equal(d.lastOpened.folder, join(project, 'a'));
  assert.equal(d.films.length, 1);
  assert.equal(d.films[0].folder, join(project, 'a'));
  assert.equal(d.films[0].exists, true);
  assert.ok(d.jobs.length >= 1 && d.jobs.every((job) => ['id', 'kind', 'title', 'state', 'exitCode', 'started', 'ended', 'progress', 'folder', 'outputs', 'tail'].every((key) => key in job)));
  // nothing in what is answered holds the editor's address or key
  const everything = JSON.stringify(message);
  for (const secret of ['SECRETKEY-7f3a9', '45678', 'origin', '"key"', '127.0.0.1', 'http://']) assert.ok(!everything.includes(secret), secret);
});

test('a job of another project is not visible, a job of this one and an install are', async () => {
  mkdirSync(JOBS, { recursive: true });
  const elsewhere = folderIn('other-project');
  const made = (id, meta, code = 0) => {
    mkdirSync(join(JOBS, id), { recursive: true });
    writeFileSync(join(JOBS, id, 'meta.json'), JSON.stringify({ id, kind: id.split('-')[0], title: id, program: 'x', args: [], started: new Date().toISOString(), ran: new Date().toISOString(), ...meta }));
    writeFileSync(join(JOBS, id, 'out.log'), `log of ${id}\n`);
    writeFileSync(join(JOBS, id, 'exit.code'), `${code}\n`);
  };
  made('command-aaaaaa', { folder: elsewhere, cwd: elsewhere });
  made('render-bbbbbb', { folder: null, cwd: elsewhere });
  made('command-cccccc', { folder: null, cwd: join(project, 'a') });
  made('setup-dddddd', { folder: null, cwd: elsewhere });
  made('command-eeeeee', {});
  const ids = (await tool('film_dashboard')).result.structuredContent.jobs.map((job) => job.id);
  assert.ok(ids.includes('command-cccccc') && ids.includes('setup-dddddd'), ids.join());
  for (const hidden of ['command-aaaaaa', 'render-bbbbbb', 'command-eeeeee']) assert.ok(!ids.includes(hidden), hidden);
  for (const hidden of ['command-aaaaaa', 'render-bbbbbb', 'command-eeeeee']) {
    await refused('film_job', { id: hidden }, /no job/);
    await refused('film_cancel', { id: hidden }, /no job/);
  }
  assert.match(textOf(await tool('film_job', { id: 'command-cccccc' })), /command-cccccc/);
  assert.match(textOf(await tool('film_job', { id: 'setup-dddddd' })), /setup-dddddd/);
});

test('the version in server.mjs is the one plugin.json says (plugin.json is not copied to where the plugin runs)', () => {
  const source = readFileSync(join(root, 'server.mjs'), 'utf8');
  assert.equal(source.match(/export const VERSION = '([^']+)'/)?.[1], manifest.version);
});

test('the server starts without plugin.json, tests or dev files beside it, as where the plugin runs', () => {
  const copy = folderIn('synced');
  // (one by one: cpSync ends the process on Windows when a path holds characters such as －)
  for (const folder of ['lib', 'runtime']) {
    mkdirSync(join(copy, folder));
    for (const name of readdirSync(join(root, folder))) copyFileSync(join(root, folder, name), join(copy, folder, name));
  }
  for (const name of ['server.mjs', 'tools.json']) copyFileSync(join(root, name), join(copy, name));
  const answer = spawnSync(process.execPath, ['server.mjs', project], {
    cwd: copy, input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', encoding: 'utf8', timeout: 15000, env,
  });
  assert.match(answer.stdout, new RegExp(`"serverInfo":\\{"name":"film-studio","version":"${manifest.version.replaceAll('.', '\\.')}"\\}`), answer.stderr);
});

test('closing standard input ends the server once its answers are given', async () => {
  const run = spawn(process.execPath, ['server.mjs', project], { cwd: root, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  createInterface({ input: run.stdout }).on('line', (line) => lines.push(line));
  run.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  run.stdin.end();
  const code = await new Promise((done) => run.on('exit', done));
  assert.equal(code, 0);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ jsonrpc: '2.0', id: 1, result: {} }]);
});
