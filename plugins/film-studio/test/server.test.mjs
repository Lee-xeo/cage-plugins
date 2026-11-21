import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ENV } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const toolsJson = JSON.parse(readFileSync(`${root}/tools.json`, 'utf8'));
mkdirSync(ENV.HOME, { recursive: true });

let child;
const waiting = new Map();
let next = 1;

before(() => {
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ...ENV }, stdio: ['pipe', 'pipe', 'inherit'] });
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
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 15000);
    waiting.set(id, (message) => { clearTimeout(timer); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });

test('initialize echoes the protocol version and names the server', async () => {
  const { result } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.equal(result.serverInfo.name, 'film-studio');
  assert.equal(result.serverInfo.version, JSON.parse(readFileSync(`${root}/plugin.json`, 'utf8')).version);
  assert.ok(result.capabilities.tools);
});

test('tools/list is tools.json', async () => {
  const { result } = await rpc('tools/list', {});
  assert.deepEqual(result.tools, toolsJson);
});

test('ping, unknown method, unknown tool', async () => {
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal((await rpc('nothing/here')).error.code, -32601);
  assert.equal((await tool('film_nope')).error.code, -32602);
  assert.equal((await tool('constructor')).error.code, -32602);
});

test('film_job with a bad id is an error result', async () => {
  const { result } = await tool('film_job', { id: 'nope' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no job/);
  assert.equal((await tool('film_cancel', { id: 'render-abcdef' })).result.isError, true);
});

test('film_open refuses a relative path', async () => {
  const { result } = await tool('film_open', { folder: 'a/b' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absolute/);
});

test('film_run refuses update and open', async () => {
  assert.equal((await tool('film_run', { args: ['update'] })).result.isError, true);
  assert.equal((await tool('film_run', { args: [] })).result.isError, true);
});

test('film_dashboard has the contract keys', async () => {
  const { result } = await tool('film_dashboard');
  assert.ok(!result.isError);
  const d = result.structuredContent;
  for (const key of ['plugin', 'openfilm', 'browser', 'ffmpeg', 'memory', 'setup', 'studio', 'terminal', 'lastOpened', 'films', 'jobs']) {
    assert.ok(key in d, `missing ${key}`);
  }
  assert.equal(d.openfilm.installed, false);
  assert.equal(typeof d.openfilm.version, 'string');
  assert.equal(d.browser.installed, false);
  assert.equal(typeof d.ffmpeg.found, 'boolean');
  assert.ok('totalMB' in d.memory && 'availableMB' in d.memory);
  assert.ok('downloadMB' in d.setup && d.setup.ffmpegCommand === 'sudo apt-get install -y ffmpeg' && 'sudo' in d.setup);
  assert.equal(typeof d.studio.running, 'boolean');
  assert.ok('command' in d.terminal && 'linked' in d.terminal && 'link' in d.terminal);
  assert.ok(Array.isArray(d.films) && Array.isArray(d.jobs));
});

test('film_terminal and film_setup validate', async () => {
  assert.equal((await tool('film_setup', { step: 'bogus' })).result.isError, true);
});

test('the version in server.mjs is the one plugin.json says (plugin.json is not copied to where the plugin runs)', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/export const VERSION = '([^']+)'/)?.[1], manifest.version);
});

test('the server starts without plugin.json beside it, as where the plugin runs', async () => {
  const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const copy = mkdtempSync(join(tmpdir(), 'film-studio-synced-'));
  try {
    cpSync(new URL('..', import.meta.url), copy, { recursive: true, filter: (from) => !from.endsWith('/plugin.json') && !from.includes('/test') });
    const answer = spawnSync(process.execPath, ['server.mjs'], {
      cwd: copy, input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', encoding: 'utf8', timeout: 15000,
      env: { ...process.env },
    });
    assert.match(answer.stdout, /"serverInfo":\{"name":"film-studio","version":"0\.1\.0"\}/, answer.stderr);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
