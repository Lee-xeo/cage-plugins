// An MCP server on standard input and output that makes videos with OpenFilm:
// films written as web pages, checked frame by frame, rendered to MP4, and
// edited by hand in OpenFilm's Studio, which the plugin's page opens.
//
// It needs only Node.js. OpenFilm itself, the browser films are drawn in and
// ffmpeg are installed the first time they are needed (lib/runtime.mjs); the
// tool list is answered at once from tools.json, before any of that.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { HOME, PLUGIN, Refused, filmFolder, shown } from './lib/paths.mjs';
import {
  BROWSER, DOWNLOAD_MB, FFMPEG_COMMAND, OPENFILM_CLI, OPENFILM_VERSION, browserInstalled, commandLinked, environment,
  ffmpegVersion, linkCommand, memory, openfilmInstalled, sudoWorks, writeCommand,
} from './lib/runtime.mjs';
import { Jobs } from './lib/jobs.mjs';
import { lookArgs, openfilm, parseOpen, renderArgs } from './lib/openfilm.mjs';
import { images } from './lib/images.mjs';
import { films, lastOpened, noteOpened, studio, thumbnail } from './lib/studio.mjs';
import { COMMAND, COMMAND_LINK } from './lib/paths.mjs';

// The plugin's version, as plugin.json says (test/server.test.mjs checks they agree). It is written here because
// plugin.json is not copied to where the plugin runs.
export const VERSION = '0.1.0';
const TOOLS = JSON.parse(readFileSync(join(PLUGIN, 'tools.json'), 'utf8'));
const WAIT = 25;

const jobs = new Jobs({ environment: (meta) => environment({ agent: meta.kind !== 'setup' && meta.agent !== false }) });

// ---------------------------------------------------------------- answers

const text = (body, structured, isError = false) => ({
  content: [{ type: 'text', text: body }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError } : {}),
});

/** A job as a few lines of text. */
function describe(job) {
  const progress = job.progress
    ? ` · ${job.progress.done}/${job.progress.total} ${job.progress.unit}${job.progress.leftSeconds !== null ? ` · about ${job.progress.leftSeconds} s left` : ''}`
    : '';
  const lines = [`job ${job.id} · ${job.state}${progress}`, job.title];
  if (job.outputs.length) lines.push(`wrote: ${job.outputs.map(shown).join(', ')}`);
  if (['queued', 'running'].includes(job.state)) lines.push(`call film_job with id ${job.id} to follow it`);
  if (job.tail.length) lines.push('', ...job.tail.slice(job.state === 'running' ? -5 : -30));
  return lines.join('\n');
}

const jobAnswer = (job) => text(describe(job), { job }, job.state === 'failed' || job.state === 'stopped');

/** A finished look: its report and the pictures it drew. */
function lookAnswer(job) {
  if (['queued', 'running'].includes(job.state)) return jobAnswer(job);
  const report = job.tail.join('\n');
  // Exit status 1 is a film with problems, which the report says; 2 is a wrong command or no project.
  const failed = job.state !== 'done' && job.exitCode !== 1;
  const pictures = failed ? [] : images(job.outputs);
  const rest = job.outputs.slice(pictures.length).map(shown);
  const body = `${report}${rest.length ? `\n\nmore pictures: ${rest.join(', ')}` : ''}`;
  return { content: [{ type: 'text', text: body }, ...pictures], structuredContent: { job }, ...(failed ? { isError: true } : {}) };
}

// ---------------------------------------------------------------- what OpenFilm needs

/**
 * Make sure OpenFilm and its browser are installed: if not, install them as a
 * job, wait a while, and when that is not enough say how to follow it.
 */
async function ready({ ffmpeg = false, wait = WAIT } = {}) {
  if (!openfilmInstalled() || !browserInstalled()) {
    const existing = jobs.active('setup');
    const job = existing ? jobs.view(existing.id) : jobs.create({
      kind: 'setup', title: `install OpenFilm ${OPENFILM_VERSION} and its render browser`,
      program: process.execPath, args: [join(PLUGIN, 'lib', 'setup.mjs'), 'runtime'], cwd: HOME, agent: false,
    });
    const done = await jobs.wait(job.id, Math.max(wait, 5));
    if (!openfilmInstalled() || !browserInstalled()) {
      if (['queued', 'running'].includes(done.state)) {
        throw new Refused(`OpenFilm is being installed for its first use (about ${DOWNLOAD_MB.openfilm + DOWNLOAD_MB.browser} MB; job ${done.id}). `
          + `Follow it with film_job, then call this tool again.\n${describe(done)}`);
      }
      throw new Refused(`OpenFilm could not be installed.\n${describe(done)}`);
    }
  }
  writeCommand();
  if (ffmpeg && !ffmpegVersion()) {
    throw new Refused(`ffmpeg and ffprobe are needed and not installed. Install them with \`${FFMPEG_COMMAND}\` in a terminal, `
      + 'or ask the person to press Prepare in the Film Studio page.');
  }
}

const seconds = (value, fallback = WAIT) => (Number.isFinite(value) ? Math.max(0, Math.min(55, value)) : fallback);

/** Start an `openfilm` command as a job in the film's folder. */
function command(kind, args, { folder = null, title, agent = true }) {
  return jobs.create({
    kind, title: title ?? `openfilm ${args.join(' ')}`.slice(0, 200), program: process.execPath, args: [OPENFILM_CLI, ...args],
    cwd: folder ?? HOME, folder, agent,
  });
}

function checkArgs(args) {
  if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Refused('args is a list of words: the command and its arguments');
  }
  if (args[0] === 'update') throw new Refused(`this OpenFilm is pinned to ${OPENFILM_VERSION}; a newer one comes with a newer plugin`);
  if (args[0] === 'open') throw new Refused('use film_open to create or open a film');
  return args;
}

// ---------------------------------------------------------------- tools

const GUIDE_NOTE = `This OpenFilm is ${OPENFILM_VERSION}, run by tools here. With a terminal, run the commands below as written. `
  + 'Without one, use the tools: `open` is film_open, `look` is film_look, `render` is film_render, and any other command '
  + 'is film_run with the words after the command name as args. The person watches and edits in Studio, opened from the '
  + 'Film Studio page: after film_open, tell them to open it there.\n\n';

const handlers = {
  async film_guide({ skill }) {
    await ready();
    const name = typeof skill === 'string' && skill.trim();
    const answer = await openfilm(name ? ['skill', name] : [], { cwd: HOME });
    if (answer.code !== 0) throw new Refused((answer.stderr || answer.stdout).trim() || `openfilm exited with ${answer.code}`);
    return text(`${name ? '' : GUIDE_NOTE}${answer.stdout.trim()}`);
  },

  async film_open({ folder }) {
    const path = filmFolder(folder);
    await ready();
    const answer = await openfilm(['open', path], { cwd: HOME });
    const opened = parseOpen(`${answer.stdout}\n${answer.stderr}`);
    if (answer.code !== 0 || !opened.url) throw new Refused((answer.stderr || answer.stdout).trim() || 'the editor did not start');
    noteOpened(opened.project ?? path);
    const where = opened.project ?? path;
    return text(`film  ${shown(where)}\neditor  ${opened.url}\n`
      + (opened.alreadyOpen ? 'The editor is already open and now shows this film.' : 'The person opens it from the Film Studio page (Open in Studio).'),
    { folder: where, url: opened.url, alreadyOpen: opened.alreadyOpen });
  },

  async film_look(options) {
    const folder = filmFolder(options.folder);
    const args = lookArgs(options);
    await ready({ ffmpeg: true });
    const job = command('look', args, { folder });
    return lookAnswer(await jobs.wait(job.id, 55));
  },

  async film_render(options) {
    const folder = filmFolder(options.folder);
    const args = renderArgs(options);
    await ready({ ffmpeg: true });
    const { availableMB } = memory();
    if (!args.includes('--workers') && availableMB !== null && availableMB < 4096) args.push('--workers', '1');
    const job = command('render', args, { folder, title: `render ${shown(folder)}${options.range ? ` (${options.range} s)` : ''}` });
    return jobAnswer(await jobs.wait(job.id, seconds(options.wait_seconds)));
  },

  async film_run({ args, folder, wait_seconds }) {
    checkArgs(args);
    const path = folder ? filmFolder(folder) : null;
    await ready({ ffmpeg: ['look', 'render'].includes(args[0]) });
    const kind = args[0] === 'render' ? 'render' : args[0] === 'look' ? 'look' : 'command';
    const job = await jobs.wait(command(kind, args, { folder: path }).id, seconds(wait_seconds));
    return kind === 'look' ? lookAnswer(job) : jobAnswer(job);
  },

  async film_job({ id, wait_seconds }) {
    const job = await jobs.wait(id, seconds(wait_seconds));
    return job.kind === 'look' ? lookAnswer(job) : jobAnswer(job);
  },

  async film_cancel({ id }) {
    return jobAnswer(jobs.cancel(id));
  },

  // ---- the page's own

  async film_dashboard() {
    const { running, origin } = studio();
    const ffmpeg = cached('ffmpeg', 10_000, ffmpegVersion);
    return text('dashboard', {
      plugin: VERSION,
      openfilm: { version: OPENFILM_VERSION, installed: openfilmInstalled() },
      browser: { installed: browserInstalled(), version: BROWSER?.browserVersion ?? null },
      ffmpeg: { found: Boolean(ffmpeg), version: ffmpeg },
      memory: memory(),
      setup: { downloadMB: DOWNLOAD_MB, ffmpegCommand: FFMPEG_COMMAND, sudo: cached('sudo', 60_000, sudoWorks) },
      studio: { running, origin },
      terminal: { command: shown(COMMAND), linked: commandLinked(), link: shown(COMMAND_LINK) },
      lastOpened: lastOpened(),
      films: films(),
      jobs: jobs.list(12),
    });
  },

  async film_setup({ step }) {
    if (!['all', 'runtime', 'openfilm', 'browser', 'ffmpeg'].includes(step)) throw new Refused('step is all, runtime, openfilm, browser or ffmpeg');
    if (step === 'ffmpeg' && !ffmpegVersion() && !sudoWorks()) {
      throw new Refused(`installing ffmpeg needs an administrator password here; run this in a terminal: ${FFMPEG_COMMAND}`);
    }
    const existing = jobs.active('setup');
    const job = existing ? jobs.view(existing.id) : jobs.create({
      kind: 'setup', title: { all: 'prepare everything', runtime: 'install OpenFilm and its render browser', openfilm: `install OpenFilm ${OPENFILM_VERSION}`, browser: 'install the render browser', ffmpeg: 'install ffmpeg' }[step],
      program: process.execPath, args: [join(PLUGIN, 'lib', 'setup.mjs'), step], cwd: HOME, agent: false,
    });
    delete memo.ffmpeg;
    return jobAnswer(job);
  },

  async film_studio({ folder }) {
    const path = folder ? filmFolder(folder) : null;
    await ready({ wait: 50 });
    const answer = await openfilm(path ? ['open', path] : ['open'], { cwd: HOME, agent: false });
    const opened = parseOpen(`${answer.stdout}\n${answer.stderr}`);
    if (!opened.url) throw new Refused((answer.stderr || answer.stdout).trim() || 'the editor did not start');
    return text(opened.url, { url: opened.url, alreadyOpen: opened.alreadyOpen, folder: opened.project });
  },

  async film_thumbnail({ folder }) {
    const dataUrl = await thumbnail(filmFolder(folder));
    return text('thumbnail', { dataUrl });
  },

  async film_terminal({ enable }) {
    const linked = linkCommand(Boolean(enable));
    return text(linked ? `openfilm now runs ${shown(COMMAND)} in new terminals` : 'the openfilm link is removed',
      { linked, link: shown(COMMAND_LINK), command: shown(COMMAND) });
  },
};

const memo = {};
function cached(key, ms, compute) {
  const hit = memo[key];
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = compute();
  memo[key] = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- JSON-RPC

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function call(id, params) {
  const name = params?.name;
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
  if (!handler) {
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
    return;
  }
  let result;
  try {
    result = await handler(params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
  } catch (error) {
    if (!(error instanceof Refused)) process.stderr.write(`${name}: ${error.stack || error}\n`);
    result = text(error instanceof Refused ? error.message : `${name} failed: ${error.message}`, null, true);
  }
  write({ jsonrpc: '2.0', id, result });
}

function answer(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'film-studio', version: VERSION },
      instructions: 'Make videos with OpenFilm: call film_guide first and follow it; check every change with film_look.',
    } });
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    pending++;
    call(id, params).finally(() => { pending--; if (closed && !pending) process.exit(0); });
  } else if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

try { writeCommand(); } catch (error) { process.stderr.write(`the openfilm command could not be written: ${error.message}\n`); }
// Waiting renders start when the one before them ends, whether or not anyone asks.
setInterval(() => { try { jobs.pump(); } catch { /* next time */ } }, 5000).unref();

let pending = 0;
let closed = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message && typeof message === 'object') answer(message);
}).on('close', () => {
  // Calls still being answered finish first; jobs run on by themselves.
  closed = true;
  if (!pending) process.exit(0);
});
