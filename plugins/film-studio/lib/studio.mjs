// Studio and the films it knows: its address (run.json), the projects list
// (studio.json), and small pictures of each film for the page.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CACHE, DATA, OPENFILM_HOME, Refused, shown } from './paths.mjs';
import { outputsOf } from './jobs.mjs';
import { openfilm } from './openfilm.mjs';

const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** Whether Studio runs, and where. */
export function studio() {
  const run = json(join(OPENFILM_HOME, 'run.json'));
  let running = false;
  if (run?.pid) { try { process.kill(run.pid, 0); running = true; } catch { /* gone */ } }
  return { running, origin: running ? run.origin ?? null : null, key: running ? run.key ?? null : null };
}

// What the page should know of the last film Claude opened.
const STATE = join(DATA, 'state.json');
export function noteOpened(folder) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ lastOpened: { folder, at: new Date().toISOString() } }));
}
export function lastOpened() {
  const last = json(STATE)?.lastOpened;
  return last?.folder ? { ...last, shown: shown(last.folder) } : null;
}

const VIDEO = ['mp4', 'webm', 'mov'];

/** One film as the page lists it. */
function film(folder, id = null) {
  const page = join(folder, 'film.html');
  let modified = null;
  try { modified = statSync(page).mtime.toISOString(); } catch { /* gone */ }
  let video = null;
  for (const ext of VIDEO) {
    const path = join(folder, `${basename(folder)}.${ext}`);
    try { video = { path, shown: shown(path), bytes: statSync(path).size }; break; } catch { /* not rendered */ }
  }
  return { id, folder, shown: shown(folder), name: basename(folder), modified, exists: modified !== null, video };
}

/** The films Studio has opened, most recent first, and the one Claude opened last. */
export function films(limit = 40) {
  const state = json(join(OPENFILM_HOME, 'studio.json'));
  const recent = Array.isArray(state?.recent) ? state.recent : [];
  const list = recent.filter((entry) => typeof entry?.path === 'string').slice(0, limit).map((entry) => film(entry.path, entry.id ?? null));
  const last = lastOpened();
  if (last && !list.some((item) => item.folder === last.folder)) list.unshift(film(last.folder));
  return list;
}

/** A picture shrunk to a thumbnail, as a data: address (needs ffmpeg). */
function shrink(source, target) {
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '6', target], { timeout: 20000 });
  if (made.status !== 0 || !existsSync(target)) throw new Refused('the picture could not be made smaller (is ffmpeg installed?)');
}

let turn = Promise.resolve();

/**
 * A small picture of the film: its own cover, else Studio's poster of it, else
 * a frame `openfilm look` draws. One at a time: each may start a browser.
 */
export function thumbnail(folder) {
  const result = turn.then(() => makeThumbnail(folder));
  turn = result.catch(() => {});
  return result;
}

async function makeThumbnail(folder) {
  const page = join(folder, 'film.html');
  if (!existsSync(page)) throw new Refused(`${shown(folder)} has no film.html`);
  const key = createHash('sha1').update(`${folder}\n${statSync(page).mtimeMs}`).digest('hex');
  const target = join(CACHE, 'thumbs', `${key}.jpg`);
  if (!existsSync(target)) {
    mkdirSync(join(CACHE, 'thumbs'), { recursive: true });
    const cover = ['jpg', 'jpeg', 'png', 'webp'].map((ext) => join(folder, '.film', `cover.${ext}`)).find(existsSync);
    let source = cover ?? await poster(folder);
    if (!source) {
      const looked = await openfilm(['look', '1'], { cwd: folder, seconds: 60 });
      source = outputsOf(looked.stdout, folder).find((path) => /\.(jpe?g|png)$/i.test(path) && existsSync(path));
      if (!source) throw new Refused(`no picture of the film yet: ${(looked.stderr || looked.stdout).trim().split('\n').pop() || 'it may be empty'}`);
    }
    shrink(source, target);
  }
  return `data:image/jpeg;base64,${readFileSync(target).toString('base64')}`;
}

/** Studio's poster of a film it knows, saved to a file; null when Studio cannot give one now. */
async function poster(folder) {
  const { running, origin, key } = studio();
  const entry = films(200).find((item) => item.folder === folder);
  if (!running || !origin || !key || !entry?.id) return null;
  try {
    const response = await fetch(`${origin}/api/projects/${encodeURIComponent(entry.id)}/poster`, {
      headers: { 'x-studio-key': key }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const file = join(CACHE, 'thumbs', `poster-${entry.id}.img`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}
