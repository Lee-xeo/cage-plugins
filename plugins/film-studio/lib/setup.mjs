// Get what OpenFilm needs ready: `node lib/setup.mjs all|openfilm|browser`.
// Runs as a background job of the server (lib/jobs.mjs): what it prints is the
// job's log, and lines "progress <done>/<total> <unit>" are its progress.
import { Refused } from './paths.mjs';
import { installBrowser, installOpenfilm } from './runtime.mjs';

const say = (text) => process.stdout.write(`${text}\n`);
const steps = { openfilm: installOpenfilm, browser: installBrowser };
const wanted = process.argv[2] === 'all' ? Object.keys(steps) : [process.argv[2]];
if (!wanted.every((step) => steps[step])) {
  say('usage: setup.mjs all|openfilm|browser');
  process.exit(2);
}
let failed = false;
for (const step of wanted) {
  try {
    await steps[step](say);
  } catch (error) {
    failed = true;
    say(error instanceof Refused ? error.message : `${step}: ${error.stack || error}`);
  }
}
process.exit(failed ? 1 : 0);
