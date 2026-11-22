// Work that takes longer than a call: renders, installs, long `openfilm`
// commands. Each job is run by a process of its own (lib/job-runner.mjs) that
// outlives the server, and everything about it is in its folder, jobs/<id>/,
// so the next server reads where it is. A job is alive while its runner keeps
// touching its folder: no process id is trusted, which another program may
// have by then.
// One render runs at a time, the others wait their turn: each takes about a
// gigabyte of memory per browser it draws in.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { JOBS, PLUGIN, Refused } from './paths.mjs';

const KEPT = 32;
const OTHERS_AT_ONCE = 4;
const TAIL_LINES = 30;
const TAIL_BYTES = 64 * 1024;
/** A runner not heard of for this long is gone. */
const SILENT_MS = 15_000;

/** Text without terminal colours, and with only what the last carriage return left of each line. */
export const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n')
  .map((line) => line.split('\r').filter(Boolean).pop() ?? '').join('\n');

/**
 * How far a job has got, from what it printed: a render's "k/N frames · about S s left",
 * or a "progress d/t unit" line of the setup.
 */
export function progressOf(text) {
  let found = null;
  for (const line of plain(text).split('\n')) {
    const frames = line.match(/(\d+)\/(\d+) frames(?: · about (\d+) s left)?/);
    if (frames) { found = { done: +frames[1], total: +frames[2], unit: 'frames', leftSeconds: frames[3] ? +frames[3] : null }; continue; }
    const start = line.match(/rendering (\d+) frames/);
    if (start) { found = { done: 0, total: +start[1], unit: 'frames', leftSeconds: null }; continue; }
    const step = line.match(/^progress ([\d.]+)\/([\d.]+) (\w+)/);
    if (step) found = { done: +step[1], total: +step[2], unit: step[3], leftSeconds: null };
  }
  return found;
}

/** The files a command said it wrote: OpenFilm prints "→ <path>" for each. */
export function outputsOf(text, cwd) {
  const found = [];
  for (const line of plain(text).split('\n')) {
    const match = line.match(/^\s*→\s+(.+?)\s*$/);
    if (!match) continue;
    const path = isAbsolute(match[1]) ? match[1] : resolve(cwd || '/', match[1]);
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

function tailOf(file) {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

export class Jobs {
  /** @param {{ root?: string, environment: (meta: object) => object }} options */
  constructor({ root = JOBS, environment }) {
    this.root = root;
    this.environment = environment;
  }

  folder(id) {
    if (typeof id !== 'string' || !/^[a-z]+-[0-9a-f]{6}$/.test(id)) throw new Refused(`there is no job ${id}`);
    return join(this.root, id);
  }

  meta(id) {
    try { return JSON.parse(readFileSync(join(this.folder(id), 'meta.json'), 'utf8')); } catch { return null; }
  }

  save(meta) {
    const at = join(this.folder(meta.id), 'meta.json');
    writeFileSync(`${at}.new`, JSON.stringify(meta, null, 1));
    renameSync(`${at}.new`, at);
  }

  /** Whether the job's runner is still there. */
  alive(meta) {
    if (!meta?.ran) return false;
    let heard = Date.parse(meta.ran);
    try { heard = Math.max(heard, statSync(join(this.folder(meta.id), 'alive')).mtimeMs); } catch { /* just started */ }
    return Date.now() - heard < SILENT_MS;
  }

  exitCode(id) {
    try { return Number.parseInt(readFileSync(join(this.folder(id), 'exit.code'), 'utf8'), 10); } catch { return null; }
  }

  state(meta) {
    const code = this.exitCode(meta.id);
    if (meta.cancelled && (code !== null || !this.alive(meta))) return 'cancelled';
    if (code !== null) return code === 0 ? 'done' : 'failed';
    if (!meta.ran) return meta.cancelled ? 'cancelled' : 'queued';
    return this.alive(meta) ? 'running' : 'stopped';
  }

  /** What a caller is told about a job. */
  view(id) {
    this.pump();
    const meta = this.meta(id);
    if (!meta) throw new Refused(`there is no job ${id}`);
    const state = this.state(meta);
    const text = tailOf(join(this.folder(id), 'out.log'));
    const lines = plain(text).split('\n').filter((line) => line.trim());
    let ended = meta.ended ?? null;
    if (!ended && !['queued', 'running'].includes(state)) {
      try { ended = statSync(join(this.folder(id), 'exit.code')).mtime.toISOString(); } catch { ended = new Date().toISOString(); }
      this.save({ ...meta, ended });
    }
    return {
      id, kind: meta.kind, title: meta.title, state, exitCode: this.exitCode(id),
      started: meta.started, ended,
      progress: state === 'done' ? null : progressOf(text),
      folder: meta.folder ?? null,
      outputs: outputsOf(text, meta.cwd).filter((path) => existsSync(path)),
      tail: lines.slice(-TAIL_LINES),
    };
  }

  ids() {
    let entries = [];
    try { entries = readdirSync(this.root); } catch { /* none yet */ }
    return entries.filter((id) => /^[a-z]+-[0-9a-f]{6}$/.test(id))
      .map((id) => ({ id, meta: this.meta(id) })).filter((entry) => entry.meta)
      .sort((a, b) => String(b.meta.started).localeCompare(String(a.meta.started)));
  }

  /** The jobs a caller may see, newest first. */
  list(limit = 12, mine = () => true) {
    return this.ids().filter(({ meta }) => mine(meta)).slice(0, limit).map(({ id }) => this.view(id));
  }

  /** The newest job of a kind that has not finished, if any. */
  active(kind) {
    return this.ids().map(({ meta }) => meta).find((meta) => meta.kind === kind && ['queued', 'running'].includes(this.state(meta))) ?? null;
  }

  /**
   * Start a job (or queue it, for a render while another one runs).
   * @param {{ kind: string, title: string, program: string, args: string[], cwd: string, folder?: string, agent?: boolean }} job
   */
  create({ kind, title, program, args, cwd, folder = null, agent = true }) {
    if (!existsSync(cwd)) throw new Refused(`the folder ${cwd} does not exist`);
    const running = this.ids().map(({ meta }) => meta).filter((meta) => ['queued', 'running'].includes(this.state(meta)));
    if (kind !== 'render' && running.filter((meta) => meta.kind !== 'render').length >= OTHERS_AT_ONCE) {
      throw new Refused(`${OTHERS_AT_ONCE} jobs are already running; wait for one to finish, or cancel one`);
    }
    this.prune();
    const id = `${kind}-${randomBytes(3).toString('hex')}`;
    mkdirSync(this.folder(id), { recursive: true });
    const meta = { id, kind, title, program, args, cwd, folder, agent, started: new Date().toISOString(), ran: null };
    this.save(meta);
    writeFileSync(join(this.folder(id), 'out.log'), '');
    const busy = kind === 'render' && running.some((other) => other.kind === 'render');
    if (busy) writeFileSync(join(this.folder(id), 'out.log'), 'waiting for the render before it to finish\n');
    else this.start(meta);
    return this.view(id);
  }

  start(meta) {
    const now = new Date().toISOString();
    this.save({ ...meta, ran: now, started: now });
    const runner = spawn(process.execPath, [join(PLUGIN, 'lib', 'job-runner.mjs'), this.folder(meta.id)], {
      cwd: this.folder(meta.id), env: this.environment(meta), detached: true, stdio: 'ignore', windowsHide: true,
    });
    runner.on('error', (error) => writeFileSync(join(this.folder(meta.id), 'exit.code'), `127 ${error.message}\n`));
    runner.unref();
  }

  /** Start the next waiting render once none runs. */
  pump() {
    const metas = this.ids().map(({ meta }) => meta).filter((meta) => meta.kind === 'render');
    if (metas.some((meta) => this.state(meta) === 'running')) return;
    const next = metas.filter((meta) => this.state(meta) === 'queued').sort((a, b) => a.started.localeCompare(b.started))[0];
    if (next) {
      writeFileSync(join(this.folder(next.id), 'out.log'), '');
      this.start(next);
    }
  }

  /** Wait up to `seconds` for the job to finish; answer where it is then. */
  async wait(id, seconds) {
    const until = Date.now() + Math.max(0, Math.min(seconds, 55)) * 1000;
    let view = this.view(id);
    while (['queued', 'running'].includes(view.state) && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 400));
      view = this.view(id);
    }
    return view;
  }

  /** Stop a job: a waiting one never starts, a running one is asked to end, then ended after 6 s. */
  cancel(id) {
    const meta = this.meta(id);
    if (!meta) throw new Refused(`there is no job ${id}`);
    if (['queued', 'running'].includes(this.state(meta))) {
      writeFileSync(join(this.folder(id), 'cancel'), '');
      this.save({ ...meta, cancelled: true });
    }
    return this.view(id);
  }

  /** Forget the oldest finished jobs beyond the KEPT newest. */
  prune() {
    const finished = this.ids().filter(({ meta }) => !['queued', 'running'].includes(this.state(meta)));
    for (const { id } of finished.slice(KEPT)) rmSync(this.folder(id), { recursive: true, force: true });
  }
}
