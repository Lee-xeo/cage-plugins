import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderIn } from './helpers.mjs';

process.env.OPENAI_API_KEY = 'sk-test-secret';
process.env.AWS_SECRET_ACCESS_KEY = 'aws-test-secret';
process.env.GH_TOKEN = 'gh-test-secret';
process.env.ANTHROPIC_API_KEY = 'ant-test-secret';
process.env.NODE_OPTIONS = '--no-warnings';

const runtime = await import('../lib/runtime.mjs');
const { OPENFILM_HOME, BROWSERS } = await import('../lib/paths.mjs');
const { nodeProblem, environment, searchPath, BROWSER, OPENFILM_VERSION, FFMPEG_COMMAND, DOWNLOAD_MB, memory, ffmpegVersion, browserInstalled, openfilmInstalled } = runtime;

test('nodeProblem by version', () => {
  assert.equal(nodeProblem('22.2.0'), null);
  assert.equal(nodeProblem('22.3.1'), null);
  assert.equal(nodeProblem('22.12.0'), null);
  assert.equal(nodeProblem('23.0.0'), null);
  assert.equal(nodeProblem('24.22.3'), null);
  assert.equal(nodeProblem('100.0.0'), null);
  for (const old of ['22.1.9', '22.0.0', '20.19.0', '18.20.4', '1.0.0']) {
    assert.match(nodeProblem(old), new RegExp(`22\\.2 or later.*${old.replaceAll('.', '\\.')}`), old);
  }
  assert.equal(nodeProblem(), null); // the Node running these tests
});

test('environment drops secrets and sets what OpenFilm needs', () => {
  const env = environment();
  for (const secret of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.ok(!(secret in env), secret);
  assert.ok(!JSON.stringify(env).includes('test-secret'));
  assert.equal(env.OPENFILM_HOME, OPENFILM_HOME);
  assert.equal(env.OPENFILM_NO_UPDATE_CHECK, '1');
  assert.equal(env.OPENFILM_NO_STATS, '1');
  assert.equal(env.OPENFILM_NO_BROWSER, '1');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, BROWSERS);
  assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  assert.equal(env.OPENFILM_RUN, 'openfilm');
  assert.equal(env.OPENFILM_AGENT, 'Claude');
  assert.ok(env.PATH.length > 0);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.XDG_CACHE_HOME, process.env.XDG_CACHE_HOME);
});

test('environment: the agent flag', () => {
  assert.equal(environment({ agent: true }).OPENFILM_AGENT, 'Claude');
  assert.ok(!('OPENFILM_AGENT' in environment({ agent: false })));
  assert.equal(environment({ agent: false }).OPENFILM_HOME, OPENFILM_HOME);
});

test('environment: proxies are kept, and Node is told to use them', () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete process.env[key];
    assert.ok(!('NODE_USE_ENV_PROXY' in environment()));
    process.env.HTTPS_PROXY = 'http://proxy.invalid:3128';
    const env = environment();
    assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid:3128');
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
  } finally {
    for (const key of ['HTTPS_PROXY', 'https_proxy']) if (!(key in saved)) delete process.env[key];
  }
});

test('searchPath holds PATH, once each, and the usual places', () => {
  const path = searchPath();
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) assert.ok(path.includes(entry), entry);
  assert.equal(new Set(path).size, path.length);
  assert.ok(path.every(Boolean));
  assert.equal(environment().PATH, path.join(delimiter));
  if (process.platform !== 'win32') assert.ok(path.includes('/usr/local/bin') && path.includes('/opt/homebrew/bin'));
});

test('winget: its links, and the folder of an ffmpeg it could make no links for', () => {
  const local = folderIn('local');
  const packages = join(local, 'Microsoft', 'WinGet', 'Packages');
  const bin = join(packages, 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.1-full_build', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ffmpeg.exe'), '');
  mkdirSync(join(packages, 'Other.Tool_x', 'v', 'bin'), { recursive: true });
  writeFileSync(join(packages, 'Other.Tool_x', 'v', 'bin', 'ffmpeg.exe'), '');
  assert.deepEqual(runtime.winget(local), [join(local, 'Microsoft', 'WinGet', 'Links'), bin]);
  assert.deepEqual(runtime.winget(folderIn('none')).length, 1);
  assert.deepEqual(runtime.winget(undefined), []);
});

test('runtime/browser.json: every build is pinned', () => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../runtime/browser.json', import.meta.url)), 'utf8'));
  assert.deepEqual(raw, BROWSER);
  assert.match(raw.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(raw.folder && Array.isArray(raw.markers));
  const builds = Object.entries(raw.builds);
  assert.ok(builds.length >= 4, 'builds for macOS, Linux and Windows');
  for (const [key, build] of builds) {
    assert.match(key, /^(darwin|linux|win32)-(x64|arm64|ia32)$/, key);
    assert.ok(Array.isArray(build.urls) && build.urls.length >= 1, key);
    for (const url of build.urls) {
      assert.match(url, /^https:\/\/[^/\s]+\/\S+\.zip$/, `${key} ${url}`);
      assert.ok(url.endsWith(`/${build.file}`), `${key} ${url} is not ${build.file}`);
    }
    assert.ok(Number.isInteger(build.size) && build.size > 1_000_000, key);
    assert.match(build.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(typeof build.executable === 'string' && build.executable && !build.executable.startsWith('/') && !build.executable.includes('..'), key);
  }
  for (const wanted of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) assert.ok(wanted in raw.builds, wanted);
});

test('what the runtime says about this computer', () => {
  assert.match(OPENFILM_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(FFMPEG_COMMAND, { win32: 'winget install --id Gyan.FFmpeg -e', darwin: 'brew install ffmpeg' }[process.platform] ?? 'sudo apt-get install -y ffmpeg');
  assert.equal(typeof DOWNLOAD_MB.openfilm, 'number');
  assert.equal(typeof DOWNLOAD_MB.browser, 'number');
  const total = memory();
  assert.ok(total.totalMB > 0);
  assert.ok(total.availableMB === null || total.availableMB > 0);
  const found = ffmpegVersion();
  assert.ok(found === null || typeof found === 'string');
  // a scratch cache holds nothing installed
  assert.equal(openfilmInstalled(), false);
  assert.equal(browserInstalled(), false);
});
