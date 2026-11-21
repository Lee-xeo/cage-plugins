// The `openfilm` command as the tools use it: the arguments each tool's options
// become, what its output says, and short runs whose answer is waited for.
import { spawn } from 'node:child_process';
import { Refused, expandHome } from './paths.mjs';
import { OPENFILM_CLI, environment } from './runtime.mjs';
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

/** The loudness option: true means -14 LUFS, what online video is mixed at. */
function loudness(value) {
  if (value === true) return -14;
  if (value === false) return null;
  return number('loudness', value, -70, -5);
}

/** `openfilm render` arguments from film_render's options. */
export function renderArgs(o = {}) {
  const args = ['render'];
  if (o.range !== undefined && o.range !== null && o.range !== '') {
    if (!SPAN.test(String(o.range))) throw new Refused('range is a stretch in seconds, such as 3-6');
    args.push(String(o.range));
  }
  const fps = number('fps', o.fps, 1, 240);
  if (fps !== null) args.push('--fps', String(fps));
  if (o.uhd) args.push('--4k');
  const scale = number('scale', o.scale, 0.1, 8);
  if (scale !== null) args.push('--scale', String(scale));
  if (o.blur) args.push('--blur');
  if (o.alpha) args.push('--alpha');
  if (o.subtitles) args.push('--subtitles');
  const loud = loudness(o.loudness);
  if (loud !== null) args.push(`--loudness=${loud}`);
  const workers = number('workers', o.workers, 1, 64, true);
  if (workers !== null) args.push('--workers', String(workers));
  if (typeof o.out === 'string' && o.out.trim()) args.push('--out', expandHome(o.out.trim()));
  return args;
}

/** `openfilm look` arguments from film_look's options. */
export function lookArgs(o = {}) {
  const args = ['look'];
  if (typeof o.what === 'string' && o.what.trim()) {
    if (TIME.test(o.what.trim()) || SPAN.test(o.what.trim())) args.push(o.what.trim());
    else args.push(expandHome(o.what.trim()));
  }
  for (const at of Array.isArray(o.at) ? o.at : []) {
    if (!TIME.test(String(at)) && !SPAN.test(String(at))) throw new Refused(`at takes times such as 4.5 or stretches such as 3-6, not ${at}`);
    args.push(String(at));
  }
  const count = number('count', o.count, 1, 200, true);
  if (count !== null) args.push('--count', String(count));
  if (o.full) args.push('--full');
  const loud = loudness(o.loudness);
  if (loud !== null) args.push(`--loudness=${loud}`);
  return args;
}

/** What `openfilm open` printed: the project, Studio's address, and whether a page already shows it. */
export function parseOpen(text) {
  const lines = plain(text).split('\n');
  const project = lines.map((line) => line.match(/^project\s+(\/.+?)\s*$/)?.[1]).find(Boolean) ?? null;
  const url = lines.map((line) => line.match(/^Studio\s+(https?:\/\/\S+)/)?.[1]).find(Boolean) ?? null;
  return { project, url, alreadyOpen: lines.some((line) => /already open in a browser/.test(line)) };
}

/**
 * Run `openfilm <args>` and wait for it (at most `seconds`); for what answers
 * quickly: the guide, a skill, open.
 */
export function openfilm(args, { cwd, agent = true, seconds = 50 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [OPENFILM_CLI, ...args], {
      cwd, env: environment({ agent }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), seconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); done({ code: 127, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? 124 : 1), stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}
