// What OpenFilm needs to run on this computer, and how it is run.
//
// - OpenFilm itself: the npm packages locked in runtime/package-lock.json (each
//   with its integrity hash), installed with `npm ci` the first time they are
//   needed, then changed as lib/patches.mjs says.
// - The browser films are drawn in: the build of Chrome Headless Shell the
//   locked playwright-core expects, downloaded and checked against the SHA-256
//   in runtime/browser.json, and pointed at with PLAYWRIGHT_BROWSERS_PATH.
// - ffmpeg and ffprobe: the person's own.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fetchPinned } from './download.mjs';
import { PATCHES_DIGEST, applyPatches } from './patches.mjs';
import { BROWSERS, CACHE, HOME, OPENFILM_HOME, PLUGIN, Refused } from './paths.mjs';
import { unzip } from './zip.mjs';

const WINDOWS = process.platform === 'win32';
const RUNTIME = join(PLUGIN, 'runtime');
const read = (name) => JSON.parse(readFileSync(join(RUNTIME, name), 'utf8'));

/** The OpenFilm version runtime/package.json names. */
export const OPENFILM_VERSION = read('package.json').dependencies.openfilm;
export const BROWSER = read('browser.json');
const BUILD = BROWSER.builds[`${process.platform}-${process.arch}`] ?? null;
/** About how much the first install downloads, in MB, for the page to say. */
export const DOWNLOAD_MB = { openfilm: 80, browser: Math.round((BUILD?.size ?? 0) / 1e6) };
/** How ffmpeg is installed here. */
export const FFMPEG_COMMAND = WINDOWS ? 'winget install --id Gyan.FFmpeg -e' : process.platform === 'darwin' ? 'brew install ffmpeg' : 'sudo apt-get install -y ffmpeg';
/** The oldest Node.js OpenFilm runs on. */
const NODE = [22, 2];

export function nodeProblem(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > NODE[0] || (major === NODE[0] && minor >= NODE[1]) ? null : `Node.js ${NODE.join('.')} or later is needed; this computer runs ${version}`;
}

const lockDigest = createHash('sha256').update(readFileSync(join(RUNTIME, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 8);
const OPENFILM_ROOT = join(CACHE, 'openfilm');
const OPENFILM_NAME = `${OPENFILM_VERSION}-${lockDigest}-${PATCHES_DIGEST}`;
export const OPENFILM_DIR = join(OPENFILM_ROOT, OPENFILM_NAME);
const cliIn = (folder) => join(folder, 'node_modules', 'openfilm', 'bin', 'openfilm.mjs');
export const OPENFILM_CLI = cliIn(OPENFILM_DIR);

/** npm's own program, run with this Node: on Windows `npm` is a script no program can start directly. */
function npm() {
  const beside = dirname(realpathSync(process.execPath));
  const found = [join(beside, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(beside, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const folder of searchPath()) {
    for (const name of ['npm', 'npm-cli.js']) { try { found.push(realpathSync(join(folder, name))); } catch { /* not here */ } }
    found.push(join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  const cli = found.find((file) => file.endsWith('npm-cli.js') && existsSync(file));
  if (!cli) throw new Refused('npm, which comes with Node.js, was not found');
  return cli;
}

/** Where winget puts ffmpeg: a link in one folder, or where it may make no links, the package's own folder added to PATH. */
export function winget(local) {
  if (!local) return [];
  const root = join(local, 'Microsoft', 'WinGet');
  const found = [join(root, 'Links')];
  const list = (folder) => { try { return readdirSync(folder).sort().reverse(); } catch { return []; } };
  for (const name of list(join(root, 'Packages')).filter((entry) => /^[\w-]+\.FFmpeg(?![a-z])/i.test(entry))) {
    for (const version of list(join(root, 'Packages', name))) {
      if (existsSync(join(root, 'Packages', name, version, 'bin', 'ffmpeg.exe'))) found.push(join(root, 'Packages', name, version, 'bin'));
    }
  }
  return found;
}

/** Where programs are looked for: PATH, and where ffmpeg's usual installers put it (a running app keeps its old PATH). */
export function searchPath() {
  const now = (process.env.PATH ?? process.env.Path ?? '').split(delimiter);
  const more = WINDOWS
    ? [...winget(process.env.LOCALAPPDATA), process.env.ProgramData && join(process.env.ProgramData, 'chocolatey', 'bin'), join(HOME, 'scoop', 'shims')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set([...now, ...more].filter(Boolean))];
}

// Of this computer's environment OpenFilm is given what programs need to run,
// and nothing else: no keys or tokens kept in it.
const KEPT = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);

function base() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => KEPT.has(key.toUpperCase())));
  env.PATH = searchPath().join(delimiter);
  // Node's own downloads go through the proxy the person set, as npm's do.
  if (Object.keys(env).some((key) => /^https?_proxy$/i.test(key))) env.NODE_USE_ENV_PROXY = '1';
  return env;
}

/**
 * The environment OpenFilm runs in. `agent`: the call comes from Claude, which
 * the editor then names and gives its agents' key.
 */
export function environment({ agent = true } = {}) {
  return {
    ...base(),
    OPENFILM_HOME,
    OPENFILM_NO_UPDATE_CHECK: '1',
    OPENFILM_NO_STATS: '1',
    OPENFILM_NO_BROWSER: '1', // the plugin opens the editor (lib/studio.mjs)
    PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    OPENFILM_RUN: 'openfilm',
    ...(agent ? { OPENFILM_AGENT: 'Claude' } : {}),
  };
}

// ---------------------------------------------------------------- installing

export const openfilmInstalled = () => existsSync(join(OPENFILM_DIR, '.complete')) && existsSync(OPENFILM_CLI);

/** Install the locked packages, unless they are there. `say` gets each line to show. */
export async function installOpenfilm(say) {
  if (openfilmInstalled()) { say(`OpenFilm ${OPENFILM_VERSION} is installed`); return; }
  const problem = nodeProblem();
  if (problem) throw new Refused(problem);
  mkdirSync(OPENFILM_ROOT, { recursive: true });
  const staging = mkdtempSync(join(OPENFILM_ROOT, '.installing-'));
  try {
    copyFileSync(join(RUNTIME, 'package.json'), join(staging, 'package.json'));
    copyFileSync(join(RUNTIME, 'package-lock.json'), join(staging, 'package-lock.json'));
    const total = Object.entries(read('package-lock.json').packages ?? {}).filter(([path, entry]) => path && !entry.dev && entry.resolved).length;
    say(`installing OpenFilm ${OPENFILM_VERSION}: ${total} packages from the npm registry, each checked against the lock file`);
    let fetched = 0;
    const code = await run(process.execPath, [npm(), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=http'], {
      cwd: staging, env: { ...base(), npm_config_update_notifier: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      line: (text) => {
        if (/\bfetch GET 200 \S+\.tgz/.test(text)) say(`progress ${++fetched}/${total} packages`);
        else if (/\b(ERR|error|WARN)\b/i.test(text)) say(text);
      },
    });
    if (code !== 0) throw new Refused(`npm could not install OpenFilm (exit status ${code}); check the network connection and try again`);
    const version = spawnSync(process.execPath, [cliIn(staging), '--version'], { encoding: 'utf8', env: environment(), windowsHide: true }).stdout?.trim();
    if (version !== OPENFILM_VERSION) throw new Refused(`the installed OpenFilm says it is ${version || 'nothing'}, not ${OPENFILM_VERSION}`);
    applyPatches(join(staging, 'node_modules', 'openfilm'));
    writeFileSync(join(staging, '.complete'), `${OPENFILM_NAME}\n`);
    rmSync(OPENFILM_DIR, { recursive: true, force: true });
    renameSync(staging, OPENFILM_DIR);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // Versions this plugin no longer runs; one still in use is left for the next time.
  for (const entry of readdirSync(OPENFILM_ROOT)) {
    if (entry === OPENFILM_NAME || entry.startsWith('.installing-')) continue;
    try { rmSync(join(OPENFILM_ROOT, entry), { recursive: true, force: true }); } catch { /* in use */ }
  }
  say(`OpenFilm ${OPENFILM_VERSION} is installed`);
}

const browserDir = () => join(BROWSERS, BROWSER.folder);
export const browserInstalled = () => Boolean(BUILD) && existsSync(join(browserDir(), '.complete')) && existsSync(join(browserDir(), BUILD.executable));

/** Download, check and unpack the browser films are drawn in, unless it is there. */
export async function installBrowser(say) {
  if (browserInstalled()) { say(`the render browser (Chrome ${BROWSER.browserVersion}) is installed`); return; }
  if (!BUILD) throw new Refused(`there is no render browser for this computer (${process.platform} ${process.arch})`);
  say(`downloading the render browser, Chrome Headless Shell ${BROWSER.browserVersion} (${(BUILD.size / 1e6).toFixed(0)} MB)`);
  const zip = await fetchPinned(BUILD, join(CACHE, 'downloads', BUILD.file), say);
  say('the download matches its recorded SHA-256; unpacking it');
  mkdirSync(BROWSERS, { recursive: true });
  const staging = mkdtempSync(join(BROWSERS, '.unpacking-'));
  try {
    unzip(zip, staging);
    if (!existsSync(join(staging, BUILD.executable))) throw new Refused('the render browser could not be unpacked');
    for (const marker of BROWSER.markers ?? []) writeFileSync(join(staging, marker), '');
    writeFileSync(join(staging, '.complete'), `${BROWSER.browserVersion}\n`);
    rmSync(browserDir(), { recursive: true, force: true });
    renameSync(staging, browserDir());
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(zip, { force: true });
  say(`the render browser (Chrome ${BROWSER.browserVersion}) is installed`);
}

/** ffmpeg's version when both ffmpeg and ffprobe run, else null. */
export function ffmpegVersion() {
  const options = { encoding: 'utf8', timeout: 8000, env: base(), windowsHide: true };
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], options);
  if (ffmpeg.status !== 0 || spawnSync('ffprobe', ['-hide_banner', '-version'], options).status !== 0) return null;
  return ffmpeg.stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
}

/** Run ffmpeg quietly for a picture of the plugin's own; whether it worked. */
export const ffmpeg = (args, timeout = 30_000) => spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeout, env: base(), stdio: 'ignore', windowsHide: true }).status === 0;

/** Memory of the computer, in MB. */
export function memory() {
  let available = freemem();
  try { available = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)[1]) * 1024; } catch { /* not Linux */ }
  return { totalMB: Math.round(totalmem() / 1048576), availableMB: process.platform === 'darwin' ? null : Math.round(available / 1048576) };
}

/** Run a program, handing each line it prints to `line`; resolves with its exit status. */
function run(program, args, { cwd, env, line }) {
  return new Promise((done) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line);
    child.on('error', (error) => { line(`${program}: ${error.message}`); done(127); });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
