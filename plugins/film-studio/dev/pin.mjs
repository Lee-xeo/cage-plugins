#!/usr/bin/env node
// Developer script: pins the OpenFilm release this plugin runs. Not shipped logic; the plugin never runs it.
//
// Usage (from the repository root):
//   node plugins/film-studio/dev/pin.mjs [openfilm-version]
//
// With a version it first rewrites the "openfilm" dependency in runtime/package.json. Then it
//   1. resolves the whole dependency tree into runtime/package-lock.json (no packages are installed),
//   2. reads which playwright-core the lock contains and what browser build that release wants
//      (its browsers.json: chromium-headless-shell revision + Chrome version),
//   3. downloads that browser for each system and processor, measures size and SHA-256,
//   4. writes runtime/browser.json, which the plugin uses to verify the download.
// Needs: node, npm, network. Downloads about 200 MB into a temporary folder that is removed afterwards.
//
// The URL templates and executable paths below mirror playwright-core's own registry
// (lib/coreBundle.js: cftUrl, PLAYWRIGHT_CDN_MIRRORS, DOWNLOAD_PATHS, EXECUTABLE_PATHS).
// When you bump OpenFilm, check that those did not change (the script checks the ones it can).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { unzip } from '../lib/zip.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(pluginDir, 'runtime');
const packageFile = join(runtimeDir, 'package.json');
const lockFile = join(runtimeDir, 'package-lock.json');
const browserFile = join(runtimeDir, 'browser.json');

const BROWSER = 'chromium-headless-shell';
// Playwright writes this empty file into the browser folder once an install finished.
// Launching only needs the executable, but Playwright's own cleanup treats a folder without it as unfinished.
const MARKERS = ['INSTALLATION_COMPLETE'];
const CDN = 'https://cdn.playwright.dev';
const MIRRORS = [
  `${CDN}/dbazure/download/playwright`,
  'https://playwright.download.prss.microsoft.com/dbazure/download/playwright',
  CDN,
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

// Streams one URL to disk (fetch follows redirects), returns its size and SHA-256.
async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  await pipeline(createReadStream(file), hash);
  const size = (await stat(file)).size;
  const expected = Number(response.headers.get('content-length'));
  if (expected && expected !== size) throw new Error(`Short download from ${url}: ${size} of ${expected} bytes`);
  return { size, sha256: hash.digest('hex') };
}

async function fetchFirst(urls, file) {
  const failures = [];
  for (const url of urls) {
    try {
      console.log(`  downloading ${url}`);
      return { url, ...(await download(url, file)) };
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
      console.log(`  failed: ${error.message}`);
    }
  }
  throw new Error(`No mirror worked:\n${failures.join('\n')}`);
}

const requested = process.argv[2];
if (requested && !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(requested)) {
  console.error(`"${requested}" is not a version like 0.4.1`);
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), 'film-studio-pin-'));
try {
  // (a) the OpenFilm version
  const pkg = await readJson(packageFile);
  if (requested) {
    pkg.dependencies.openfilm = requested;
    await writeJson(packageFile, pkg);
  }
  const openfilm = pkg.dependencies.openfilm;
  console.log(`OpenFilm ${openfilm}`);

  // (b) the lock file, resolved in a scratch folder so runtime/ never gets a node_modules
  await copyFile(packageFile, join(work, 'package.json'));
  console.log('Resolving the lock file ...');
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], work);
  const lock = await readJson(join(work, 'package-lock.json'));
  if (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages[''].dependencies.openfilm !== openfilm) {
    throw new Error('The lock file does not match runtime/package.json; npm ci would refuse it.');
  }
  const installed = lock.packages['node_modules/openfilm']?.version;
  if (installed !== openfilm) throw new Error(`The lock holds openfilm ${installed}, not ${openfilm}.`);
  await copyFile(join(work, 'package-lock.json'), lockFile);
  const packages = Object.keys(lock.packages).length - 1;

  // (c) which browser build this playwright-core wants
  const playwrightCore = lock.packages['node_modules/playwright-core']?.version;
  if (!playwrightCore) throw new Error('playwright-core is not in the lock file.');
  console.log(`playwright-core ${playwrightCore}; reading its browsers.json ...`);
  const packDir = join(work, 'pack');
  run('mkdir', ['-p', packDir]);
  const tarball = run('npm', ['pack', `playwright-core@${playwrightCore}`, '--silent'], packDir).trim().split('\n').pop();
  run('tar', ['-xzf', tarball, '-C', packDir, 'package/browsers.json', 'package/lib/coreBundle.js'], packDir);
  const browsers = await readJson(join(packDir, 'package', 'browsers.json'));
  const entry = browsers.browsers.find((b) => b.name === BROWSER);
  if (!entry?.revision || !entry.browserVersion) throw new Error(`browsers.json has no usable ${BROWSER} entry.`);
  const { revision, browserVersion } = entry;

  // Guard against playwright-core changing the layout we hard-code below.
  const core = await readFile(join(packDir, 'package', 'lib', 'coreBundle.js'), 'utf8');
  const expectSnippets = [
    'path: `builds/cft/${browserVersion}/${suffix}`',
    'cftUrl("linux64/chrome-headless-shell-linux64.zip")',
    'cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip")',
    'cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip")',
    'cftUrl("win64/chrome-headless-shell-win64.zip")',
    '"mac-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"]',
    '"mac-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"]',
    '"win-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]',
    '"builds/chromium/%s/chromium-headless-shell-linux-arm64.zip"',
    ...MIRRORS.map((m) => `"${m}"`),
    '"linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"]',
    '"linux-arm64": ["chrome-linux", "headless_shell"]',
    'join(browserDirectory, "INSTALLATION_COMPLETE")',
  ];
  const missing = expectSnippets.filter((s) => !core.includes(s));
  if (missing.length) throw new Error(`playwright-core ${playwrightCore} changed; update pin.mjs. Not found:\n${missing.join('\n')}`);

  // (d) download addresses, built the way playwright-core builds them
  const cft = (name, program = 'chrome-headless-shell') => ({
    file: `chrome-headless-shell-${name}.zip`,
    urls: [`${CDN}/builds/cft/${browserVersion}/${name}/chrome-headless-shell-${name}.zip`],
    executable: `chrome-headless-shell-${name}/${program}`,
  });
  // keys are `${process.platform}-${process.arch}`
  const targets = {
    'darwin-arm64': cft('mac-arm64'),
    'darwin-x64': cft('mac-x64'),
    'linux-x64': cft('linux64'),
    'linux-arm64': {
      file: 'chromium-headless-shell-linux-arm64.zip',
      urls: MIRRORS.map((m) => `${m}/builds/chromium/${revision}/chromium-headless-shell-linux-arm64.zip`),
      executable: 'chrome-linux/headless_shell',
    },
    'win32-x64': cft('win64', 'chrome-headless-shell.exe'),
  };

  // (e) fetch and measure
  const builds = {};
  for (const [arch, target] of Object.entries(targets)) {
    console.log(`Browser for ${arch} ...`);
    const got = await fetchFirst(target.urls, join(work, target.file));
    // it must unpack with the plugin's own unpacker, to the program it names
    unzip(join(work, target.file), join(work, arch));
    await access(join(work, arch, target.executable));
    await rm(join(work, arch), { recursive: true, force: true });
    await rm(join(work, target.file), { force: true });
    builds[arch] = { file: target.file, urls: target.urls, size: got.size, sha256: got.sha256, executable: target.executable };
    console.log(`  ${got.size} bytes, sha256 ${got.sha256}`);
  }

  // (g) the record
  await writeJson(browserFile, {
    playwrightCore,
    browser: BROWSER,
    revision,
    browserVersion,
    folder: `${BROWSER.replace(/-/g, '_')}-${revision}`,
    markers: MARKERS,
    builds,
  });

  console.log('\nPinned:');
  console.log(`  openfilm ${openfilm}, ${packages} packages locked (${lockFile})`);
  console.log(`  ${BROWSER} revision ${revision}, Chrome ${browserVersion}, via playwright-core ${playwrightCore}`);
  console.log(`  ${browserFile}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
