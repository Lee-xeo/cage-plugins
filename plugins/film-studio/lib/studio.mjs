// The editor (OpenFilm's Studio) and the project's films: opening the editor in
// the person's own browser, which films there are, and a small picture of each.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path, { basename, join } from 'node:path';
import { CACHE, DATA, OPENFILM_HOME, PLUGIN, Refused } from './paths.mjs';
import { outputsOf } from './jobs.mjs';
import { openfilm, parseOpen } from './openfilm.mjs';
import { ffmpeg } from './runtime.mjs';

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** Whether the editor runs. Its address and key stay where they are. */
export function studio() {
  const run = json(join(OPENFILM_HOME, 'run.json'));
  if (!run?.pid) return { running: false };
  try { process.kill(run.pid, 0); return { running: true }; } catch { return { running: false }; }
}

/** Show an address of the editor in the person's browser. Only the editor's: it is told by what it must look like. */
export function openBrowser(url, { platform = process.platform, start = spawn } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/[\w\-.~%/?=&+]*$/.test(url)) throw new Refused('that is not an address of the editor');
  const [program, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['/usr/bin/open', [url]] : ['xdg-open', [url]];
  return new Promise((done) => {
    const child = start(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => done(false));
    child.on('spawn', () => { child.unref(); done(true); });
  });
}

/**
 * Open a film in the editor (made if it is not there), and the editor in the
 * person's browser unless a page of it is open already. The address holds the
 * person's key, so it is never answered.
 */
export async function openEditor(folder, project) {
  // A project's folder is one only when a film is in it: the film gets a folder of its own otherwise.
  if (folder === project.root && !existsSync(join(folder, 'film.html'))) throw new Refused('the film needs a folder of its own inside the project');
  const answer = await openfilm(['open', folder], { cwd: project.root, agent: false });
  const opened = parseOpen(`${answer.stdout}\n${answer.stderr}`);
  if (answer.code !== 0 || !opened.url) throw new Refused((answer.stderr || answer.stdout).trim() || 'the editor did not start');
  giveLocalize(folder, project);
  const shown = opened.alreadyOpen || await openBrowser(opened.url);
  return { folder, alreadyOpen: opened.alreadyOpen, shown };
}

/** Where a film's copy of lib/localize.mjs is. */
export const localizeIn = (folder) => join(folder, '.film', 'film-studio', 'localize.mjs');

/** Put lib/localize.mjs where the caller can run it: in the film's folder, which they reach too. */
export function giveLocalize(folder, project) {
  if (!existsSync(join(folder, 'film.html'))) return;
  const to = project.inside(localizeIn(folder), 'a file');
  const from = join(PLUGIN, 'lib', 'localize.mjs');
  if (existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) return;
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const STATE = join(DATA, 'state.json');
export function noteOpened(folder) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ lastOpened: { folder, at: new Date().toISOString() } }));
}

const within = (root, folder) => { const back = path.relative(root, folder); return back !== '..' && !back.startsWith(`..${path.sep}`) && !path.isAbsolute(back); };

export function lastOpened(project) {
  const last = json(STATE)?.lastOpened;
  return last?.folder && within(project.root, last.folder) ? { ...last, shown: last.folder } : null;
}

const SKIP = new Set(['node_modules', 'assets', 'scenes', 'dist', 'build', 'target', 'vendor']);
const DEEP = 3;
const MOST_FOLDERS = 600;
const MOST_FILMS = 40;

/** Mark a film as shown already: the editor is opened by film_open, not by a look or a render. */
export function markShown(folder) {
  const marks = join(folder, '.film');
  mkdirSync(marks, { recursive: true });
  if (!existsSync(join(marks, 'opened'))) writeFileSync(join(marks, 'opened'), '');
}

const OF_A_FILM = /\.(html?|css|m?js|json|svg|png|jpe?g|webp|gif)$/i;

/** When a film last changed: film.html, or a page, style, script or picture beside it or in a folder of it; null without film.html. */
export function changed(folder) {
  let newest;
  try { newest = statSync(join(folder, 'film.html')).mtimeMs; } catch { return null; }
  let looked = 0;
  const look = (dir, deep) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* not readable */ }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || (looked += 1) > 400) continue;
      if (entry.isDirectory()) { if (deep < DEEP) look(join(dir, entry.name), deep + 1); } else if (entry.isFile() && OF_A_FILM.test(entry.name)) {
        try { newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs); } catch { /* gone */ }
      }
    }
  };
  look(folder, 0);
  return newest;
}

/** One film as the page lists it. */
function film(folder) {
  const at = changed(folder);
  const modified = at === null ? null : new Date(at).toISOString();
  let video = null;
  for (const ext of ['mp4', 'webm', 'mov']) {
    const file = join(folder, `${basename(folder)}.${ext}`);
    try { video = { path: file, shown: file, bytes: statSync(file).size }; break; } catch { /* not rendered */ }
  }
  return { folder, shown: folder, name: basename(folder), modified, exists: modified !== null, video };
}

/** The films in the project's folder, changed last first. */
export function films(project) {
  const found = [];
  let looked = 0;
  let level = [project.root];
  for (let deep = 0; deep <= DEEP && level.length; deep += 1) {
    const next = [];
    for (const folder of level) {
      if ((looked += 1) > MOST_FOLDERS || found.length >= MOST_FILMS) break;
      if (existsSync(join(folder, 'film.html'))) found.push(film(folder));
      let entries = [];
      try { entries = readdirSync(folder, { withFileTypes: true }); } catch { /* not readable */ }
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) next.push(join(folder, entry.name));
    }
    level = next;
  }
  return found.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
}

let turn = Promise.resolve();

/** A small picture of the film. One at a time: each may start a browser. */
export function thumbnail(folder) {
  const result = turn.then(() => makeThumbnail(folder));
  turn = result.catch(() => {});
  return result;
}

async function makeThumbnail(folder) {
  const at = changed(folder);
  if (at === null) throw new Refused('there is no film.html in the folder');
  // the cover the person chose in the editor, else a frame. (Not the editor's own poster: it may be the one before the last change.)
  const cover = ['jpg', 'jpeg', 'png', 'webp'].map((ext) => join(folder, '.film', `cover.${ext}`)).find((file) => existsSync(file) && within(folder, realpathSync(file)));
  const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 20);
  const thumbs = join(CACHE, 'thumbs');
  const mine = `${hash(folder)}-`;
  const name = `${mine}${hash(`${at}\n${cover ? statSync(cover).mtimeMs : ''}`)}.jpg`;
  const target = join(thumbs, name);
  if (!existsSync(target)) {
    mkdirSync(thumbs, { recursive: true });
    let source = cover;
    if (!source) {
      markShown(folder);
      const looked = await openfilm(['look', '1'], { cwd: folder, seconds: 55 });
      source = outputsOf(looked.stdout, folder).find((file) => /\.(jpe?g|png)$/i.test(file) && existsSync(file));
      if (!source) throw new Refused(`no picture of the film yet: ${(looked.stderr || looked.stdout).trim().split('\n').pop() || 'it may be empty'}`);
    }
    if (!ffmpeg(['-i', source, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '6', target]) || !existsSync(target)) throw new Refused('the picture could not be made smaller (is ffmpeg installed?)');
    for (const old of readdirSync(thumbs)) if (old.startsWith(mine) && old !== name) rmSync(join(thumbs, old), { force: true });
  }
  return `data:image/jpeg;base64,${readFileSync(target).toString('base64')}`;
}
