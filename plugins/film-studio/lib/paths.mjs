// Where the plugin keeps things, and how paths are taken in and shown.
//
// The plugin's own folder is replaced whole each time the application copies it
// in, so nothing it makes is kept there:
//   CACHE  ~/.cache/film-studio        what can be fetched again: OpenFilm's
//                                       packages, the render browser, thumbnails
//   DATA   ~/.local/share/film-studio   what is the person's: OpenFilm's own
//                                       state (home/), the command script (bin/),
//                                       the background jobs (jobs/)
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const CACHE = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'film-studio');
export const DATA = join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'film-studio');

/** OpenFilm's state folder (OPENFILM_HOME): its keys, settings, projects list and Studio's address. */
export const OPENFILM_HOME = join(DATA, 'home');
/** The command script that runs the pinned `openfilm`. */
export const COMMAND = join(DATA, 'bin', 'openfilm');
/** Where the person may ask for the command to be linked, a folder on the terminal's PATH. */
export const COMMAND_LINK = join(HOME, '.local', 'bin', 'openfilm');
export const JOBS = join(DATA, 'jobs');
export const BROWSERS = join(CACHE, 'browsers');
/** The plugin's own folder: lib/.. */
export const PLUGIN = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A refusal worded for whoever called: the message is shown as it is. */
export class Refused extends Error {}

/** The path with the home folder written as ~, for showing. */
export function shown(path) {
  if (typeof path !== 'string') return path;
  if (path === HOME) return '~';
  return path.startsWith(HOME + sep) ? '~' + path.slice(HOME.length) : path;
}

/** ~ and ~/x as the home folder. */
export function expandHome(path) {
  if (path === '~') return HOME;
  return path.startsWith('~/') ? join(HOME, path.slice(2)) : path;
}

/** Where new films go unless a folder is named: Studio's choice in its settings, else ~/Videos/OpenFilm/Projects. */
export function projectsFolder() {
  try {
    const prefs = JSON.parse(readFileSync(join(OPENFILM_HOME, 'prefs.json'), 'utf8'));
    if (prefs && typeof prefs.projectsFolder === 'string' && isAbsolute(prefs.projectsFolder)) return prefs.projectsFolder;
  } catch { /* none chosen */ }
  return join(HOME, 'Videos', 'OpenFilm', 'Projects');
}

/**
 * A film's folder as the caller gave it: an absolute path, ~/…, or a bare name
 * (made in the projects folder). Anything else relative would land beside this
 * program, so it is refused.
 */
export function filmFolder(given) {
  if (typeof given !== 'string' || !given.trim()) throw new Refused('folder is required: the absolute path of the film\'s folder');
  const text = given.trim();
  if (/[\0\n\r]/.test(text)) throw new Refused('folder holds a character a path cannot have');
  const expanded = expandHome(text);
  if (isAbsolute(expanded)) {
    const path = normalize(expanded).replace(/(.)\/+$/, '$1');
    if (path === '/' || path === HOME) throw new Refused(`${shown(path)} cannot be a film's folder; name a folder of its own`);
    return path;
  }
  if (!text.includes('/') && text !== '.' && text !== '..') return join(projectsFolder(), text);
  throw new Refused(`folder must be an absolute path (or a bare name for a new film), not ${text}`);
}
