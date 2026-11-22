// Runs one background job: node lib/job-runner.mjs <the job's folder>. A
// process of its own, so the job goes on when the server that started it ends
// (the plugin reloaded, another project opened). It is told everything by
// files in the job's folder and says everything the same way:
//
//   meta.json   what to run      out.log    what it prints
//   cancel      asks it to stop  alive      touched while it runs
//   exit.code   how it ended
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv[2];
const { program, args, cwd } = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'));
const out = openSync(join(folder, 'out.log'), 'a');
const windows = process.platform === 'win32';
const child = spawn(program, args, { cwd, stdio: ['ignore', out, out], detached: !windows, windowsHide: true });
closeSync(out);

function ended(code) {
  writeFileSync(join(folder, 'exit.code.new'), `${code}\n`);
  renameSync(join(folder, 'exit.code.new'), join(folder, 'exit.code'));
  process.exit(0);
}
child.on('error', (error) => { writeFileSync(join(folder, 'out.log'), `${error.message}\n`, { flag: 'a' }); ended(127); });
child.on('exit', (code, signal) => ended(code ?? (signal ? 128 : 1)));

// The program and every program it started.
function kill(signal) {
  if (windows) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; }
  try { process.kill(-child.pid, signal); } catch { /* gone */ }
}
let asked = 0;
setInterval(() => {
  try { writeFileSync(join(folder, 'alive'), String(Date.now())); } catch { /* next time */ }
  if (!existsSync(join(folder, 'cancel'))) return;
  asked += 1;
  if (asked === 1) kill('SIGTERM');
  else if (asked === 12) kill('SIGKILL');
}, 500);
