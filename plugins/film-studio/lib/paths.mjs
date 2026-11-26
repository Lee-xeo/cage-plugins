// Where the plugin keeps things on this computer, and how paths are taken in
// and shown.
//
// Whoever calls may see the project's folder under another spelling than this
// computer does: D:\Films\a is /d/Films/a to them (on macOS and Linux the two
// are the same). Paths are taken in either spelling, shown in theirs, and are
// always inside the project folder, with links followed first.
//
//   CACHE  what can be fetched again: OpenFilm's packages, the render browser, thumbnails
//   DATA   what is the person's: OpenFilm's own state (home/) and the background jobs (jobs/)
//
// The plugin's own folder is replaced whole when it is updated, so nothing it
// makes is kept there.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from './refused.mjs';

export { Refused };
export const HOME = homedir();

/** The plugin's two folders on a system. */
export function roots(platform = process.platform, env = process.env, home = HOME) {
  if (platform === 'win32') {
    const base = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'film-studio');
    return { cache: path.win32.join(base, 'cache'), data: path.win32.join(base, 'data') };
  }
  if (platform === 'darwin') {
    return { cache: path.posix.join(home, 'Library', 'Caches', 'film-studio'), data: path.posix.join(home, 'Library', 'Application Support', 'film-studio') };
  }
  return {
    cache: path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, '.cache'), 'film-studio'),
    data: path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'film-studio'),
  };
}

export const { cache: CACHE, data: DATA } = roots();
/** OpenFilm's state folder (OPENFILM_HOME): its keys, settings and the editor's address. */
export const OPENFILM_HOME = join(DATA, 'home');
export const JOBS = join(DATA, 'jobs');
export const BROWSERS = join(CACHE, 'browsers');
/** The plugin's own folder: lib/.. */
export const PLUGIN = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A path as this computer spells it: on Windows /d/x is D:\x. */
export function toHost(given, platform = process.platform) {
  if (platform !== 'win32') return given;
  const drive = given.match(/^\/([A-Za-z])(\/.*)?$/);
  return drive ? `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replaceAll('/', '\\')}` : given;
}

/** A path as the caller spells it: on Windows D:\x is /d/x. */
export function toCaller(given, platform = process.platform) {
  if (platform !== 'win32') return given;
  const drive = given.match(/^([A-Za-z]):([\\/].*)?$/);
  return drive ? `/${drive[1].toLowerCase()}${(drive[2] ?? '').replaceAll('\\', '/').replace(/\/$/, '')}` : given;
}

/** The path with every link on the way followed, as far as it exists. */
function real(given) {
  const rest = [];
  for (let at = given; ; at = path.dirname(at)) {
    try { return join(realpathSync.native(at), ...rest); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      if (path.dirname(at) === at) return given;
      rest.unshift(path.basename(at));
    }
  }
}

/** The open project's folder, and what may be named in it. */
export class Project {
  constructor(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Refused('open a project folder shared from this computer first');
    this.given = root;
    this.root = real(root);
  }

  /** A path as the caller gives it, as this computer's, refused unless it is inside the project. `from`: what a relative one is from. */
  inside(given, what = 'path', from = this.root) {
    if (typeof given !== 'string' || !given.trim()) throw new Refused(`${what} is required`);
    const text = given.trim();
    if (/[\0-\x1f]/.test(text)) throw new Refused(`${what} holds a character a path cannot have`);
    if (/^(\\\\|\/\/)/.test(text) || text.startsWith('~')) throw new Refused(`${what} must be inside the project folder ${this.shown(this.root)}`);
    const host = toHost(text);
    const full = path.isAbsolute(host) ? resolve(host) : resolve(from, host);
    if (process.platform === 'win32' && /[:*?"<>|]/.test(full.slice(2))) throw new Refused(`${what} holds a character a path cannot have`);
    const found = real(full);
    const back = path.relative(this.root, found);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new Refused(`${what} must be inside the project folder ${this.shown(this.root)}`);
    }
    return found;
  }

  /** A film's folder: an absolute path inside the project, or one relative to it (a bare name for a new film). */
  film(given) {
    const folder = this.inside(given, 'folder');
    if (path.relative(this.root, folder).split(path.sep).some((part) => part.startsWith('.'))) throw new Refused('a film cannot be in a hidden folder');
    return folder;
  }

  /** A path as the caller spells it. */
  shown(host) {
    if (typeof host !== 'string') return host;
    const back = path.relative(this.root, host);
    const outside = back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
    return toCaller(outside ? host : join(this.given, back));
  }

  /**
   * Text a program printed, with this computer's spelling of the project's
   * folder as the caller's, and the home folder elsewhere as ~ (the caller's
   * own ~ is another folder, so never in a path of the project).
   */
  text(printed) {
    // a file it wrote, named from the film's folder
    let out = process.platform === 'win32' ? printed.replace(/(^|\n)([ \t]*→ )([^\n]*)/g, (_all, before, arrow, file) => `${before}${arrow}${file.replaceAll('\\', '/')}`) : printed;
    for (const root of new Set([this.root, this.given])) {
      for (const spelled of new Set([root, root.replaceAll('\\', '/')])) {
        out = out.replace(new RegExp(`${escape(spelled)}(?![\\w.-])([\\\\/][^\\s"'<>|*?]*)?`, process.platform === 'win32' ? 'gi' : 'g'),
          (_all, rest = '') => `\0${rest.replaceAll('\\', '/')}`);
      }
    }
    return out.replaceAll(HOME, '~').replaceAll('\0', toCaller(this.given));
  }

  /**
   * Refuse a film's folder that holds a link out of the project: what is
   * written into the film would be written there. (What is read through one is
   * OpenFilm's to refuse, and it does.)
   */
  noLinksOut(folder) {
    let seen = 0;
    const look = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue; // a film's packages, which nothing is written into
        if ((seen += 1) > 50_000) throw new Refused(`${this.shown(folder)} holds too many files to check for links out of the project`);
        const at = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try { this.inside(at, 'a link'); } catch { throw new Refused(`${this.shown(at)} is a link out of the project folder; remove it first`); }
        } else if (entry.isDirectory()) look(at);
      }
    };
    if (existsSync(folder)) look(folder);
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
