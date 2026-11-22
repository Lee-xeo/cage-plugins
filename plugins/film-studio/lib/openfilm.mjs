// The `openfilm` command as the tools use it: the arguments each tool's options
// become, which other commands may be run and with what, what its output says,
// and short runs whose answer is waited for.
import { spawn } from 'node:child_process';
import { Refused } from './paths.mjs';
import { OPENFILM_CLI, OPENFILM_VERSION, environment } from './runtime.mjs';
import { plain } from './jobs.mjs';

const TIME = /^\d+(\.\d+)?$/;
const SPAN = /^\d+(\.\d+)?-\d+(\.\d+)?$/;

function number(name, value, low, high, whole = false) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < low || n > high || (whole && !Number.isInteger(n))) {
    throw new Refused(`${name} is ${whole ? 'a whole number' : 'a number'} from ${low} to ${high}`);
  }
  return n;
}

const given = (value) => typeof value === 'string' && value.trim() !== '';

/** `openfilm render` arguments from film_render's options. `project`: what `out` must be inside. */
export function renderArgs(o = {}, { project, folder } = {}) {
  const args = ['render'];
  if (given(o.range)) {
    if (!SPAN.test(o.range.trim())) throw new Refused('range is a stretch in seconds, such as 3-6');
    args.push(o.range.trim());
  }
  const fps = number('fps', o.fps, 1, 240);
  if (fps !== null) args.push('--fps', String(fps));
  if (o.uhd) args.push('--4k');
  const scale = number('scale', o.scale, 0.1, 8);
  if (scale !== null) args.push('--scale', String(scale));
  if (o.blur) args.push('--blur');
  if (o.alpha) args.push('--alpha');
  if (o.subtitles) args.push('--subtitles');
  const loud = number('loudness', o.loudness, -70, -5);
  if (loud !== null) args.push(`--loudness=${loud}`);
  const workers = number('workers', o.workers, 1, 64, true);
  if (workers !== null) args.push('--workers', String(workers));
  if (given(o.out)) {
    if (!/\.(mp4|webm|mov)$/i.test(o.out.trim())) throw new Refused('out is a video file: .mp4, .webm or .mov');
    args.push('--out', project.inside(o.out, 'out', folder));
  }
  return args;
}

/** `openfilm look` arguments from film_look's options. */
export function lookArgs(o = {}, { project, folder } = {}) {
  const args = ['look'];
  if (given(o.what)) args.push(TIME.test(o.what.trim()) || SPAN.test(o.what.trim()) ? o.what.trim() : project.inside(o.what, 'what', folder));
  for (const at of Array.isArray(o.at) ? o.at : []) {
    if (!TIME.test(String(at)) && !SPAN.test(String(at))) throw new Refused(`at takes times such as 4.5 or stretches such as 3-6, not ${at}`);
    args.push(String(at));
  }
  const count = number('count', o.count, 1, 200, true);
  if (count !== null) args.push('--count', String(count));
  if (o.full) args.push('--full');
  const loud = number('loudness', o.loudness, -70, -5);
  if (loud !== null) args.push(`--loudness=${loud}`);
  return args;
}

/**
 * The other commands film_run may run: those that read, get media, and the ones
 * OpenFilm's own workbenches bring. Not here: what runs code brought from
 * elsewhere (a skill's commands, adding skills), what reaches an address the
 * caller names (get web-fetch, web-search, call), and what publishes.
 */
export const COMMANDS = {
  get: ['my-media', 'music-search', 'sfx-search', 'sticker', 'voice', 'tts', 'sfx', 'music', 'asr', 'cutout', 'image', 'image-search', 'video', 'video-search'],
  skills: [null], skill: null, doctor: [null],
  edit: ['add', 'look'], canvas: [undefined, 'apply', 'add'], color: ['look', 'input', 'balance', 'match', 'filter'],
};
/** Options whose value is words, not a path. */
const WORDS = new Set(['--prompt', '--text', '--lyrics', '--voice', '--style', '--negative', '--title', '--query']);

export function commandArgs(args, { project, folder }) {
  if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Refused('args is a list of words: the command and its arguments');
  }
  const [name, verb, ...rest] = args;
  if (['open', 'look', 'render'].includes(name)) throw new Refused(`use film_${name}`);
  if (name === 'update') throw new Refused(`this OpenFilm is kept at ${OPENFILM_VERSION}; a newer one comes with a newer plugin`);
  if (!Object.hasOwn(COMMANDS, name)) throw new Refused(`${name} cannot be run here; these can: ${Object.keys(COMMANDS).join(', ')}`);
  if (name === 'skill') {
    if (args.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9 ._@/-]*$/.test(verb) || verb.includes('..') || ['add', 'remove'].includes(verb)) throw new Refused('skill takes the name of a skill to print');
    return args;
  }
  const verbs = COMMANDS[name];
  if (verbs[0] === null) {
    if (args.length > 1) throw new Refused(`${name} takes nothing more`);
    return args;
  }
  if (!verbs.includes(verb)) throw new Refused(`${name} ${verb ?? ''} cannot be run here; these can: ${verbs.filter(Boolean).map((v) => `${name} ${v}`).join(', ')}`.replace(' ;', ';'));
  if (!folder) throw new Refused(`${name} works on a film: folder is required`);
  const checked = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const option = arg.match(/^(--[a-z0-9-]+)(?:=(.*))?$/is);
    if (option && WORDS.has(option[1])) {
      checked.push(arg);
      if (option[2] === undefined && i + 1 < rest.length) checked.push(rest[i += 1]);
    } else if (option) {
      checked.push(option[2] === undefined ? arg : `${option[1]}=${value(option[2], project, folder)}`);
    } else {
      checked.push(value(arg, project, folder));
    }
  }
  return verb === undefined ? [name] : [name, verb, ...checked];
}

/** A word that may be a path: left as it is when it names nothing elsewhere, this computer's path when it is one in the project. */
function value(word, project, folder) {
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(word) || word.startsWith('@')) throw new Refused(`${word} cannot be used here: files of the project only`);
  if (/^([\\/]|[A-Za-z]:|~)/.test(word)) return project.inside(word, 'a file');
  if (/[\\/]|^\.\.?$/.test(word)) project.inside(word, 'a file', folder);
  return word;
}

/** What `openfilm open` printed: the project, the editor's address, and whether a page already shows it. */
export function parseOpen(text) {
  const lines = plain(text).split('\n');
  const project = lines.map((line) => line.match(/^project\s+((?:\/|[A-Za-z]:[\\/]).+?)\s*$/)?.[1]).find(Boolean) ?? null;
  const url = lines.map((line) => line.match(/^Studio\s+(http:\/\/127\.0\.0\.1:\d+\/\S*)/)?.[1]).find(Boolean) ?? null;
  return { project, url, alreadyOpen: lines.some((line) => /already open in a browser/.test(line)) };
}

/** Run `openfilm <args>` and wait for it (at most `seconds`); for what answers quickly: the guide, a skill, open. */
export function openfilm(args, { cwd, agent = true, seconds = 50 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [OPENFILM_CLI, ...args], { cwd, env: environment({ agent }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), seconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); done({ code: 127, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? 124 : 1), stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}
