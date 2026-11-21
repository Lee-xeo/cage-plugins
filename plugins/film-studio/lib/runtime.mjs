// What OpenFilm needs to run here, and how it is run.
//
// - OpenFilm itself: the npm packages locked in runtime/package-lock.json (each
//   with its integrity hash), installed with `npm ci` into the cache the first
//   time they are needed. The plugin's archive stays small and nothing unlocked
//   is ever installed.
// - The browser films are drawn in: the build of Chrome Headless Shell the
//   locked playwright-core expects, downloaded and checked against the SHA-256
//   in runtime/browser.json, then pointed at with PLAYWRIGHT_BROWSERS_PATH.
// - ffmpeg and ffprobe: from the system's package manager.
// - The `openfilm` command: a small script that runs the locked CLI with the
//   settings below, for anyone working in a terminal.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fetchPinned } from './download.mjs';
import { BROWSERS, CACHE, COMMAND, COMMAND_LINK, HOME, OPENFILM_HOME, PLUGIN, Refused, shown } from './paths.mjs';

const RUNTIME = join(PLUGIN, 'runtime');
const read = (name) => JSON.parse(readFileSync(join(RUNTIME, name), 'utf8'));

/** The OpenFilm version runtime/package.json names. */
export const OPENFILM_VERSION = read('package.json').dependencies.openfilm;
/** What the browser download is pinned to (runtime/browser.json). */
export const BROWSER = existsSync(join(RUNTIME, 'browser.json')) ? read('browser.json') : null;
/** About how much the first install downloads, in MB, for the page to say. */
export const DOWNLOAD_MB = {
  openfilm: 80,
  browser: Math.round((BROWSER?.builds?.[process.arch]?.size ?? 100e6) / 1e6),
};
export const FFMPEG_COMMAND = 'sudo apt-get install -y ffmpeg';

const lockDigest = createHash('sha256').update(readFileSync(join(RUNTIME, 'package-lock.json'))).digest('hex').slice(0, 16);
const OPENFILM_ROOT = join(CACHE, 'openfilm');
/** The folder this version of OpenFilm is installed in. */
export const OPENFILM_DIR = join(OPENFILM_ROOT, `${OPENFILM_VERSION}-${lockDigest}`);
export const OPENFILM_CLI = join(OPENFILM_DIR, 'node_modules', 'openfilm', 'bin', 'openfilm.mjs');

const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- OpenFilm

export const openfilmInstalled = () => existsSync(join(OPENFILM_DIR, '.complete')) && existsSync(OPENFILM_CLI);

/** Install the locked packages, unless they are there. `say` gets each line to show. */
export async function installOpenfilm(say) {
  if (openfilmInstalled()) { say(`OpenFilm ${OPENFILM_VERSION} is installed`); return; }
  mkdirSync(OPENFILM_ROOT, { recursive: true });
  const staging = mkdtempSync(join(OPENFILM_ROOT, '.installing-'));
  try {
    copyFileSync(join(RUNTIME, 'package.json'), join(staging, 'package.json'));
    copyFileSync(join(RUNTIME, 'package-lock.json'), join(staging, 'package-lock.json'));
    const lock = read('package-lock.json');
    const total = Object.entries(lock.packages ?? {}).filter(([path, entry]) => path && !entry.dev && entry.resolved).length;
    say(`installing OpenFilm ${OPENFILM_VERSION}: ${total} packages from the npm registry, each checked against the lock file`);
    let fetched = 0;
    const code = await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=http'], {
      cwd: staging,
      env: { ...process.env, npm_config_update_notifier: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      line: (text) => {
        if (/\bfetch GET 200 \S+\.tgz/.test(text)) say(`progress ${++fetched}/${total} packages`);
        else if (/\b(ERR|error|WARN)\b/i.test(text)) say(text);
      },
    });
    if (code !== 0) throw new Refused(`npm could not install OpenFilm (exit status ${code}); check the network connection and try again`);
    const cli = join(staging, 'node_modules', 'openfilm', 'bin', 'openfilm.mjs');
    const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env: environment() }).stdout?.trim();
    if (version !== OPENFILM_VERSION) throw new Refused(`the installed OpenFilm says it is ${version || 'nothing'}, not ${OPENFILM_VERSION}`);
    writeFileSync(join(staging, '.complete'), `${OPENFILM_VERSION}\n`);
    rmSync(OPENFILM_DIR, { recursive: true, force: true });
    renameSync(staging, OPENFILM_DIR);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // Versions this plugin no longer runs.
  for (const entry of readdirSync(OPENFILM_ROOT)) {
    if (entry !== `${OPENFILM_VERSION}-${lockDigest}` && !entry.startsWith('.installing-')) {
      rmSync(join(OPENFILM_ROOT, entry), { recursive: true, force: true });
    }
  }
  writeCommand();
  say(`OpenFilm ${OPENFILM_VERSION} is installed`);
}

// ---------------------------------------------------------------- browser

const browserBuild = () => BROWSER?.builds?.[process.arch] ?? null;
const browserDir = () => join(BROWSERS, BROWSER?.folder ?? 'none');
export const browserExecutable = () => join(browserDir(), browserBuild()?.executable ?? 'none');
export const browserInstalled = () => existsSync(join(browserDir(), '.complete')) && existsSync(browserExecutable());

/** Download, check and unpack the browser films are drawn in, unless it is there. */
export async function installBrowser(say) {
  if (browserInstalled()) { say(`the render browser (Chrome ${BROWSER.browserVersion}) is installed`); return; }
  const build = browserBuild();
  if (!build) throw new Refused(`there is no render browser for this processor (${process.arch})`);
  if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).error) throw new Refused('unpacking the render browser needs unzip: sudo apt-get install -y unzip');
  say(`downloading the render browser, Chrome Headless Shell ${BROWSER.browserVersion} (${(build.size / 1e6).toFixed(0)} MB)`);
  const zip = await fetchPinned(build, join(CACHE, 'downloads', build.file), say);
  say('the download matches its recorded SHA-256; unpacking it');
  mkdirSync(BROWSERS, { recursive: true });
  const staging = mkdtempSync(join(BROWSERS, '.unpacking-'));
  try {
    const code = await run('unzip', ['-q', '-o', zip, '-d', staging], { line: say });
    if (code !== 0 || !existsSync(join(staging, build.executable))) throw new Refused('the render browser could not be unpacked');
    for (const marker of BROWSER.markers ?? []) writeFileSync(join(staging, marker), '');
    writeFileSync(join(staging, '.complete'), `${BROWSER.browserVersion}\n`);
    rmSync(browserDir(), { recursive: true, force: true });
    renameSync(staging, browserDir());
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(zip, { force: true });
  for (const entry of readdirSync(BROWSERS)) {
    if (entry !== BROWSER.folder && !entry.startsWith('.unpacking-')) rmSync(join(BROWSERS, entry), { recursive: true, force: true });
  }
  say(`the render browser (Chrome ${BROWSER.browserVersion}) is installed`);
}

// ---------------------------------------------------------------- ffmpeg

/** ffmpeg's version when both ffmpeg and ffprobe run, else null. */
export function ffmpegVersion() {
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
  const ffprobe = spawnSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 5000 });
  if (ffmpeg.status !== 0 || ffprobe.status !== 0) return null;
  return ffmpeg.stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
}

/** Whether administrator commands run here without a password. */
export const sudoWorks = () => spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0;

/** Install ffmpeg with the system's package manager. */
export async function installFfmpeg(say) {
  if (ffmpegVersion()) { say(`ffmpeg ${ffmpegVersion()} is installed`); return; }
  if (!sudoWorks()) {
    throw new Refused(`ffmpeg is not installed, and installing it needs an administrator password here. Run this in a terminal: ${FFMPEG_COMMAND}`);
  }
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const apt = (...args) => run('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', ...args], { env, line: say });
  say('installing ffmpeg with apt-get');
  let code = await apt('install', '-y', '--no-install-recommends', 'ffmpeg');
  if (code !== 0) {
    say('refreshing the package lists, then trying again');
    await apt('update');
    code = await apt('install', '-y', '--no-install-recommends', 'ffmpeg');
  }
  const version = ffmpegVersion();
  if (code !== 0 || !version) throw new Refused(`ffmpeg could not be installed (exit status ${code}). Run this in a terminal: ${FFMPEG_COMMAND}`);
  say(`ffmpeg ${version} is installed`);
}

// ---------------------------------------------------------------- running OpenFilm

/** Whether the `openfilm` link in ~/.local/bin is this plugin's. */
export function commandLinked() {
  try { return lstatSync(COMMAND_LINK).isSymbolicLink() && readlinkSync(COMMAND_LINK) === COMMAND; } catch { return false; }
}

/**
 * The environment OpenFilm runs in: its own state folder, no update check or
 * install counting (this copy is pinned), no browser of its own opened (the
 * page opens Studio), the checked render browser, and the command named as the
 * script so what OpenFilm prints can be run as it is. `agent`: the call comes
 * from Claude, which Studio then names and gives its agents' key.
 */
export function environment({ agent = true } = {}) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
  const env = Object.fromEntries(keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  env.HOME ||= HOME;
  env.PATH ||= '/usr/local/bin:/usr/bin:/bin';
  env.LANG ||= 'C.UTF-8';
  Object.assign(env, {
    OPENFILM_HOME,
    OPENFILM_NO_UPDATE_CHECK: '1',
    OPENFILM_NO_STATS: '1',
    OPENFILM_NO_BROWSER: '1',
    PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    OPENFILM_RUN: commandLinked() ? 'openfilm' : sq(COMMAND),
  });
  if (agent) env.OPENFILM_AGENT = 'Claude';
  return env;
}

/** Write the `openfilm` command script (again, when what it says changed). */
export function writeCommand() {
  if (!openfilmInstalled()) return;
  const text = `#!/bin/sh
# The openfilm command of the film-studio plugin: OpenFilm ${OPENFILM_VERSION}, as the plugin installed it.
# The plugin writes this file each time it starts; changes made here are lost.
if [ "$1" = update ]; then
  echo "openfilm: this copy is OpenFilm ${OPENFILM_VERSION}, kept by the film-studio plugin; a newer OpenFilm comes with a newer plugin" >&2
  exit 2
fi
export OPENFILM_HOME=${sq(OPENFILM_HOME)}
export OPENFILM_NO_UPDATE_CHECK=1 OPENFILM_NO_STATS=1 OPENFILM_NO_BROWSER=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH=${sq(BROWSERS)}
export OPENFILM_RUN="\${OPENFILM_RUN:-${sq(COMMAND).replace(/"/g, '\\"')}}"
export OPENFILM_AGENT="\${OPENFILM_AGENT-Claude}"
exec ${sq(process.execPath)} ${sq(OPENFILM_CLI)} "$@"
`;
  let current = null;
  try { current = readFileSync(COMMAND, 'utf8'); } catch { /* not written yet */ }
  if (current === text) return;
  mkdirSync(dirname(COMMAND), { recursive: true });
  writeFileSync(`${COMMAND}.tmp`, text, { mode: 0o755 });
  chmodSync(`${COMMAND}.tmp`, 0o755);
  renameSync(`${COMMAND}.tmp`, COMMAND);
}

/** Link (or unlink) the command into ~/.local/bin, never replacing anything that is not this plugin's. */
export function linkCommand(enable) {
  if (enable) {
    if (!openfilmInstalled()) throw new Refused('OpenFilm is not installed yet; prepare it first');
    writeCommand();
    if (commandLinked()) return true;
    if (existsSync(COMMAND_LINK) || isLink(COMMAND_LINK)) {
      throw new Refused(`${shown(COMMAND_LINK)} already exists and is not this plugin's; remove it first to use this one`);
    }
    mkdirSync(dirname(COMMAND_LINK), { recursive: true });
    symlinkSync(COMMAND, COMMAND_LINK);
    return true;
  }
  if (commandLinked()) unlinkSync(COMMAND_LINK);
  return false;
}

const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

/** Memory of the system, in MB. */
export function memory() {
  try {
    const info = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map((line) => line.match(/^(\w+):\s+(\d+) kB/)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
    return { totalMB: Math.round(info.MemTotal / 1024), availableMB: Math.round((info.MemAvailable ?? info.MemFree) / 1024) };
  } catch {
    return { totalMB: null, availableMB: null };
  }
}

/** Run a program, handing each line it prints to `line`; resolves with its exit status. */
export function run(program, args, { cwd, env, line = () => {} } = {}) {
  return new Promise((done) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', (text) => line(text));
    child.on('error', (error) => { line(`${program}: ${error.message}`); done(127); });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
