// Get what OpenFilm needs ready: `node lib/setup.mjs all|runtime|openfilm|browser|ffmpeg`
// (runtime: OpenFilm and its render browser, without ffmpeg).
// Runs as a background job of the server (lib/jobs.mjs): what it prints is the
// job's log, and lines "progress <done>/<total> <unit>" are its progress.
import { Refused } from './paths.mjs';
import { installBrowser, installFfmpeg, installOpenfilm, writeCommand } from './runtime.mjs';

const say = (text) => process.stdout.write(`${text}\n`);
const steps = { openfilm: installOpenfilm, browser: installBrowser, ffmpeg: installFfmpeg };
const groups = { all: ['openfilm', 'browser', 'ffmpeg'], runtime: ['openfilm', 'browser'] };
const wanted = groups[process.argv[2]] ?? [process.argv[2]];

if (!wanted.every((step) => steps[step])) {
  say('usage: setup.mjs all|runtime|openfilm|browser|ffmpeg');
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
writeCommand();
process.exit(failed ? 1 : 0);
