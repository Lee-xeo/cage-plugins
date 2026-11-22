// Shared by the tests: a scratch home and cache, set before any lib module is loaded.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'film-studio-test-')));
export const ENV = {
  HOME: join(SCRATCH, 'home'),
  USERPROFILE: join(SCRATCH, 'home'),
  XDG_CACHE_HOME: join(SCRATCH, 'cache'),
  XDG_DATA_HOME: join(SCRATCH, 'data'),
  LOCALAPPDATA: join(SCRATCH, 'local'),
};
Object.assign(process.env, ENV);
mkdirSync(ENV.HOME, { recursive: true });
process.on('exit', () => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* still in use */ } });

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A new empty folder inside the scratch folder (links resolved). */
export const folderIn = (name = 't') => realpathSync(mkdtempSync(join(SCRATCH, `${name}-`)));

/** Wait until `check()` is truthy (up to `ms`); returns its value. */
export async function until(check, ms = 8000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(every);
  }
}
