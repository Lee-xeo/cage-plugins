// An MCP server on standard input and output that makes videos with OpenFilm:
// films written as web pages, checked frame by frame, rendered to MP4, and
// edited by hand in OpenFilm's editor, shown in the person's own browser.
//
//   node server.mjs <the open project's folder>
//
// It needs only Node.js. OpenFilm and the browser films are drawn in are
// installed the first time they are needed (lib/runtime.mjs); the tool list is
// answered at once from tools.json, before any of that. Everything it is asked
// to read or write is inside the project's folder (lib/paths.mjs), and a film's
// pages cannot reach the network (lib/patches.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, relative } from 'node:path';
import { PLUGIN, Project, Refused } from './lib/paths.mjs';
import {
  BROWSER, DOWNLOAD_MB, FFMPEG_COMMAND, OPENFILM_CLI, OPENFILM_VERSION, browserInstalled, environment, ffmpegVersion, memory,
  nodeProblem, openfilmInstalled,
} from './lib/runtime.mjs';
import { Jobs } from './lib/jobs.mjs';
import { commandArgs, lookArgs, openfilm, renderArgs } from './lib/openfilm.mjs';
import { images } from './lib/images.mjs';
import { addressesIn } from './lib/localize.mjs';
import { films, giveLocalize, lastOpened, localizeIn, markShown, withoutAddress, noteOpened, openEditor, studio, thumbnail } from './lib/studio.mjs';

/** The plugin's version, as plugin.json says (test/server.test.mjs checks they agree). */
export const VERSION = '0.1.0';
const TOOLS = JSON.parse(readFileSync(join(PLUGIN, 'tools.json'), 'utf8'));
const WAIT = 25;

let project;
try {
  project = new Project(process.argv[2]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const jobs = new Jobs({ environment: (meta) => environment({ agent: meta.agent !== false }) });

// ---------------------------------------------------------------- answers

const text = (body, structured, isError = false) => ({
  content: [{ type: 'text', text: withoutAddress(project.text(body)) }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError } : {}),
});

/** A job as a few lines of text. */
function describe(job) {
  const progress = job.progress
    ? ` · ${job.progress.done}/${job.progress.total} ${job.progress.unit}${job.progress.leftSeconds !== null ? ` · about ${job.progress.leftSeconds} s left` : ''}`
    : '';
  const lines = [`job ${job.id} · ${job.state}${progress}`, job.title];
  if (job.outputs.length) lines.push(`wrote: ${job.outputs.map((path) => project.shown(path)).join(', ')}`);
  if (['queued', 'running'].includes(job.state)) lines.push(`call film_job with id ${job.id} to follow it`);
  if (job.tail.length) lines.push('', ...job.tail.slice(job.state === 'running' ? -5 : -30));
  return lines.join('\n');
}

/** Whether a job is this project's to see: one of a film in it, one run in it, or an install. */
function mine(meta) {
  if (meta?.kind === 'setup') return true;
  try { project.inside(meta?.folder ?? meta?.cwd); return true; } catch { return false; }
}
function checkMine(id) {
  if (!mine(jobs.meta(id))) throw new Refused(`there is no job ${id}`);
}

// Claude is told in words (and pictures) only: where an answer also has
// structured content, some clients show the model that and not the words.
const jobAnswer = (job) => text(describe(job), null, job.state === 'failed' || job.state === 'stopped');

/** Pictures a job of this project wrote, inside the project only. */
const picturesOf = (job) => job.outputs.filter((path) => { try { project.inside(path); return true; } catch { return false; } });

/** How a look says a page was refused an address: by OpenFilm's own rule, or by the page's policy. */
const BLOCKED = /web pages load only from their own folder|\bcsp https?:|Content Security Policy/i;

/** What to do about addresses a film's pages were refused. */
function hint(job) {
  const refused = job.tail.filter((line) => BLOCKED.test(line)).join('\n');
  if (!refused || !job.folder) return '';
  const can = addressesIn(refused);
  if (!can.length) return '\n\nA film\'s pages are drawn with the network closed: put what they load into the film\'s folder.';
  const run = `node ${quoted(project.shown(localizeIn(job.folder)))} ${quoted(project.shown(job.folder))}`;
  return '\n\nA film\'s pages are drawn with the network closed. To bring these fonts and scripts into the film\'s folder and have the pages '
    + `load them from there, run this in a terminal, then look again:\n${run}\nWithout a terminal, ask the person to choose Download online files (下载在线素材) for this film in the Film Studio page.`;
}
const quoted = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** A finished look: its report and the pictures it drew. */
function lookAnswer(job) {
  if (['queued', 'running'].includes(job.state)) return jobAnswer(job);
  // Exit status 1 is a film with problems, which the report says; 2 is a wrong command or no project.
  const failed = job.state !== 'done' && job.exitCode !== 1;
  const inside = picturesOf(job);
  const pictures = failed ? [] : images(inside);
  const rest = inside.slice(pictures.length).map((path) => project.shown(path));
  const body = `${job.tail.join('\n')}${rest.length ? `\n\nmore pictures: ${rest.join(', ')}` : ''}${hint(job)}`;
  return { content: [...text(body).content, ...pictures], ...(failed ? { isError: true } : {}) };
}

// ---------------------------------------------------------------- what OpenFilm needs

/** Make sure OpenFilm and its browser are installed: if not, install them as a job and say how to follow it. */
async function ready({ ffmpeg = false, wait = WAIT } = {}) {
  const problem = nodeProblem();
  if (problem) throw new Refused(problem);
  if (!openfilmInstalled() || !browserInstalled()) {
    const done = await jobs.wait(setup('all').id, Math.max(wait, 5));
    if (!openfilmInstalled() || !browserInstalled()) {
      if (['queued', 'running'].includes(done.state)) {
        throw new Refused(`OpenFilm is being installed for its first use (about ${DOWNLOAD_MB.openfilm + DOWNLOAD_MB.browser} MB; job ${done.id}). `
          + `Follow it with film_job, then call this tool again.\n${describe(done)}`);
      }
      throw new Refused(`OpenFilm could not be installed.\n${describe(done)}`);
    }
  }
  if (ffmpeg && !ffmpegVersion()) {
    throw new Refused(`ffmpeg and ffprobe are needed and not installed on the person's computer. Ask them to install it there with \`${FFMPEG_COMMAND}\`.`);
  }
}

function setup(step) {
  const existing = jobs.active('setup');
  if (existing) return jobs.view(existing.id);
  return jobs.create({
    kind: 'setup', title: { all: `install OpenFilm ${OPENFILM_VERSION} and its render browser`, openfilm: `install OpenFilm ${OPENFILM_VERSION}`, browser: 'install the render browser' }[step],
    program: process.execPath, args: [join(PLUGIN, 'lib', 'setup.mjs'), step], cwd: PLUGIN, agent: false,
  });
}

const seconds = (value, fallback = WAIT) => (Number.isFinite(value) ? Math.max(0, Math.min(55, value)) : fallback);

/** A folder with a film in it. */
function filmIn(given) {
  const folder = project.film(given);
  if (!existsSync(join(folder, 'film.html'))) throw new Refused(`${project.shown(folder)} has no film.html; film_open makes a film`);
  project.noLinksOut(folder);
  return folder;
}

/** A film by its place in the project, as jobs are titled. */
const nameOf = (folder) => relative(project.root, folder).replaceAll('\\', '/') || basename(folder);

/** Start an `openfilm` command as a job in the film's folder. */
function command(kind, args, { folder = null, title }) {
  if (folder) {
    project.inside(join(folder, '.film'));
    markShown(folder);
    giveLocalize(folder, project);
  }
  return jobs.create({
    kind, title: project.text(title ?? `openfilm ${args.join(' ')}`).slice(0, 200), program: process.execPath, args: [OPENFILM_CLI, ...args],
    cwd: folder ?? project.root, folder,
  });
}

// ---------------------------------------------------------------- tools

const GUIDE_NOTE = `This OpenFilm is ${OPENFILM_VERSION}. Its commands are run with tools: \`open\` is film_open, \`look\` is film_look, \`render\` is film_render, `
  + 'and the other commands named below are film_run with the words after `openfilm` as args (the folder goes in folder). They are not in a terminal. '
  + 'You write the film\'s files yourself, in the open project\'s folder. The person watches and edits in the editor, which film_open shows in their browser.\n'
  + 'A film\'s pages are drawn with the network closed. Addresses of Google Fonts, jsDelivr, unpkg and cdnjs can be written as usual, with an exact version: '
  + 'film_look says the one command that brings them into the film\'s folder. Other files a page loads must be in the film\'s folder already.\n\n';

const handlers = {
  async film_guide({ skill }) {
    await ready();
    const name = typeof skill === 'string' && skill.trim();
    const answer = await openfilm(name ? commandArgs(['skill', name], { project }) : [], { cwd: project.root });
    if (answer.code !== 0) throw new Refused((answer.stderr || answer.stdout).trim() || `openfilm exited with ${answer.code}`);
    return text(`${name ? '' : GUIDE_NOTE}${answer.stdout.trim()}`);
  },

  async film_open({ folder }) {
    const path = project.film(folder);
    project.noLinksOut(path);
    await ready();
    const opened = await openEditor(path, project);
    noteOpened(path);
    return text(`film  ${project.shown(path)}\n${opened.alreadyOpen ? 'The editor was already open in the person\'s browser and now shows this film.'
      : opened.shown ? 'The editor is open in the person\'s browser, showing this film.'
        : 'The editor runs, but no browser could be opened; the person can open it from the Film Studio page.'}`);
  },

  async film_look(options) {
    const folder = filmIn(options.folder);
    const args = lookArgs(options, { project, folder });
    await ready({ ffmpeg: true });
    const job = command('look', args, { folder });
    return lookAnswer(await jobs.wait(job.id, 55));
  },

  async film_render(options) {
    const folder = filmIn(options.folder);
    const args = renderArgs(options, { project, folder });
    await ready({ ffmpeg: true });
    const job = command('render', args, { folder, title: `render ${nameOf(folder)}${options.range ? ` (${options.range} s)` : ''}` });
    return jobAnswer(await jobs.wait(job.id, seconds(options.wait_seconds)));
  },

  async film_run({ args, folder, wait_seconds }) {
    const path = folder ? filmIn(folder) : null;
    const checked = commandArgs(args, { project, folder: path });
    await ready({ ffmpeg: ['edit', 'color'].includes(checked[0]) });
    return jobAnswer(await jobs.wait(command('command', checked, { folder: path }).id, seconds(wait_seconds)));
  },

  async film_job({ id, wait_seconds }) {
    checkMine(id);
    const job = await jobs.wait(id, seconds(wait_seconds));
    return job.kind === 'look' ? lookAnswer(job) : jobAnswer(job);
  },

  async film_cancel({ id }) {
    checkMine(id);
    return jobAnswer(jobs.cancel(id));
  },

  // ---- the page's own

  async film_dashboard() {
    const ffmpeg = cached('ffmpeg', 10_000, ffmpegVersion);
    return text('dashboard', {
      plugin: VERSION,
      project: project.given,
      node: { version: process.versions.node, problem: nodeProblem() },
      openfilm: { version: OPENFILM_VERSION, installed: openfilmInstalled() },
      browser: { installed: browserInstalled(), version: BROWSER.browserVersion },
      ffmpeg: { found: Boolean(ffmpeg), version: ffmpeg },
      memory: memory(),
      setup: { downloadMB: DOWNLOAD_MB, ffmpegCommand: FFMPEG_COMMAND },
      studio: { running: studio().running },
      lastOpened: lastOpened(project),
      films: films(project),
      jobs: jobs.list(12, mine).map((job) => ({ ...job, title: withoutAddress(job.title), tail: job.tail.map(withoutAddress) })),
    });
  },

  async film_setup({ step }) {
    if (!['all', 'openfilm', 'browser'].includes(step)) throw new Refused('step is all, openfilm or browser');
    return jobAnswer(setup(step));
  },

  async film_studio({ folder }) {
    const path = project.film(folder);
    project.noLinksOut(path);
    await ready({ wait: 45 });
    const opened = await openEditor(path, project);
    if (!opened.shown) throw new Refused('no browser could be opened on this computer');
    return text('opened', opened);
  },

  async film_localize({ folder }) {
    const path = filmIn(folder);
    return jobAnswer(jobs.create({
      kind: 'command', title: `download online files for ${nameOf(path)}`, program: process.execPath,
      args: [join(PLUGIN, 'lib', 'localize.mjs'), path], cwd: PLUGIN, folder: path, agent: false,
    }));
  },

  async film_thumbnail({ folder }) {
    const path = filmIn(folder);
    if (!openfilmInstalled() || !browserInstalled()) throw new Refused('OpenFilm is not installed yet');
    return text('thumbnail', { dataUrl: await thumbnail(path) });
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

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

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

let pending = 0;
let closed = false;

/** End once nothing is left to answer and the last answer is written out. */
function leave() {
  if (closed && !pending) process.stdout.write('', () => process.exit(0));
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
    pending += 1;
    call(id, params).finally(() => { pending -= 1; leave(); });
  } else if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

// Waiting renders start when the one before them ends, whether or not anyone asks.
setInterval(() => { try { jobs.pump(); } catch { /* next time */ } }, 5000).unref();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message && typeof message === 'object') answer(message);
}).on('close', () => {
  // Calls still being answered finish first; jobs run on by themselves.
  closed = true;
  leave();
});
