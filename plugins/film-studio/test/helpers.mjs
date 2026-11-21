// Shared by the tests: a scratch home and cache, set before any lib module is loaded.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCRATCH = mkdtempSync(join(tmpdir(), 'film-studio-test-'));
export const ENV = {
  HOME: join(SCRATCH, 'home'),
  XDG_CACHE_HOME: join(SCRATCH, 'cache'),
  XDG_DATA_HOME: join(SCRATCH, 'data'),
};
Object.assign(process.env, ENV);
