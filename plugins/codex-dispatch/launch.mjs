import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

function isFile(file, executable = false) {
  try {
    if (executable) accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function canonical(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isWithin(directory, file) {
  const relative = path.relative(directory, file);
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function isAbsolute(file) {
  if (process.platform === 'win32') {
    // A leading slash alone uses the current drive on Windows.
    return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(file);
  }
  return path.isAbsolute(file);
}

function npmEntry(directory) {
  return path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function windowsOverride(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.exe' && isFile(file)) return { command: file, args: [] };
  if (extension === '.js' && isFile(file)) return { command: process.execPath, args: [file] };
  if (/^codex\.(cmd|ps1)$/i.test(path.basename(file)) && isFile(file)) {
    const entry = npmEntry(path.dirname(file));
    if (isFile(entry)) return { command: process.execPath, args: [entry] };
  }
  return undefined;
}

function macCandidates(home) {
  return ['/Applications', path.join(home, 'Applications')].flatMap((directory) => [
    path.join(directory, 'Codex.app', 'Contents', 'Resources', 'codex'),
    path.join(directory, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli',
      'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
  ]);
}

export function findCodex({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  projectDir,
} = {}) {
  const windows = platform === 'win32';
  if (env.CODEX_BIN) {
    const file = env.CODEX_BIN;
    if (!isAbsolute(file)) throw new Error('CODEX_BIN must be an absolute path.');
    const launch = windows
      ? windowsOverride(file)
      : isFile(file, true) && { command: file, args: [] };
    if (launch) return launch;
    throw new Error('CODEX_BIN does not point to a launchable Codex CLI.');
  }

  const project = projectDir && canonical(projectDir);
  const trusted = (file) => !project || !isWithin(project, canonical(file));
  const pathValue = env.PATH ?? (windows ? env.Path : '') ?? '';
  const pathEntries = pathValue.split(windows ? ';' : ':');
  if (windows && env.APPDATA && isAbsolute(env.APPDATA)) {
    pathEntries.push(path.join(env.APPDATA, 'npm'));
  }

  for (const segment of pathEntries) {
    const directory = windows ? segment.replace(/^"(.*)"$/, '$1') : segment;
    if (!isAbsolute(directory) || !trusted(directory)) continue;
    const binary = path.join(directory, windows ? 'codex.exe' : 'codex');
    if (isFile(binary, !windows) && trusted(binary)) return { command: binary, args: [] };

    if (windows) {
      const entry = npmEntry(directory);
      if (isFile(entry) && trusted(entry)) return { command: process.execPath, args: [entry] };
    }
  }

  if (platform === 'darwin') {
    const binary = macCandidates(home).find((file) => isFile(file, true) && trusted(file));
    if (binary) return { command: binary, args: [] };
  }

  throw new Error('Codex CLI was not found. Install it on PATH or set CODEX_BIN to its absolute path.');
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function stillRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

// POSIX callers must spawn the child as a detached process group. Wait briefly
// after SIGTERM, then send SIGKILL to the group even if the leader has exited.
export async function stopTree(child) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (process.platform === 'win32') {
    if (!stillRunning(child)) return;
    try {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !isAbsolute(systemRoot)) {
        throw new Error('SystemRoot is required to locate taskkill.exe.');
      }
      await runFile(path.join(systemRoot, 'System32', 'taskkill.exe'), [
        '/PID', String(pid), '/T', '/F',
      ], { timeout: 5000, windowsHide: true });
    } catch (error) {
      if (!stillRunning(child)) return;
      child.kill();
      throw new Error('Could not stop the full Codex process tree.', { cause: error });
    }
    return;
  }

  if (signalGroup(pid, 'SIGTERM')) {
    await delay(300);
    signalGroup(pid, 'SIGKILL');
  } else if (stillRunning(child)) {
    child.kill('SIGKILL');
  }
}
