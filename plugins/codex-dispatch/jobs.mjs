import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stopTree } from './launch.mjs';

const MAX_ACTIVE = 2;
const MAX_HISTORY = 64;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const MAX_ANSWER_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 8192;
const ACTIVITIES = new Map([
  ['agent_message', 'composing_answer'],
  ['reasoning', 'reasoning'],
  ['command_execution', 'running_command'],
  ['file_change', 'attempting_file_change'],
  ['mcp_tool_call', 'calling_tool'],
  ['collab_tool_call', 'consulting_agent'],
  ['web_search', 'searching'],
  ['todo_list', 'planning'],
]);

function diagnostics(message) {
  if (typeof message !== 'string') return '';
  if (/unrecognized (?:subcommand|argument)|unexpected argument/i.test(message)) {
    return 'This Codex CLI version does not support the dispatch flags.';
  }
  if (/401 unauthorized|not logged in|authentication|required login|invalid api key/i.test(message)) {
    return 'Codex authentication failed. Check your Codex CLI login.';
  }
  if (/model.{0,120}(?:not supported|not found|unavailable|does not exist)/i.test(message)) {
    return 'The selected model is unavailable to this Codex CLI account.';
  }
  if (/rate limit|429 too many requests|usage limit|quota exceeded/i.test(message)) {
    return 'Codex reported a rate or usage limit.';
  }
  if (/failed to connect|connection refused|connection reset|stream disconnected|network (?:is )?unreachable/i.test(message)) {
    return 'Codex could not maintain its connection to the provider.';
  }
  return '';
}

function launchArguments(projectDir, model, reasoningEffort) {
  return [
    'exec', '--json', '--sandbox', 'read-only', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
    '-c', 'project_root_markers=[]',
    '-c', `projects={ ${JSON.stringify(projectDir)} = { trust_level = "untrusted" } }`,
    ...(model === undefined ? [] : ['--model', model]),
    ...(reasoningEffort === undefined ? [] : ['-c', `model_reasoning_effort="${reasoningEffort}"`]),
    '-',
  ];
}

function validate(prompt, model, reasoningEffort, requestId) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error('Prompt must contain text and be at most 128 KiB.');
  }
  if (model !== undefined && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(model))) {
    throw new Error('Invalid Codex model identifier.');
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(reasoningEffort))) {
    throw new Error('Invalid Codex reasoning effort.');
  }
  if (typeof requestId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(requestId)) {
    throw new Error('Invalid request ID.');
  }
}

// Progress has a fixed vocabulary and never forwards an event payload.
function readEvent(job, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  switch (event?.type) {
    case 'thread.started':
      job.phase = 'thread_started';
      break;
    case 'turn.started':
      job.phase = 'turn_started';
      break;
    case 'item.started':
      job.itemsStarted++;
      job.phase = 'item_started';
      break;
    case 'item.updated':
      job.phase = 'item_updated';
      break;
    case 'item.completed':
      job.itemsCompleted++;
      job.phase = 'item_completed';
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        job.oversizeAnswer = Buffer.byteLength(event.item.text) > MAX_ANSWER_BYTES;
        job.candidate = job.oversizeAnswer ? undefined : event.item.text;
      }
      break;
    case 'turn.completed':
      job.turnCompleted = true;
      job.phase = 'turn_completed';
      break;
    case 'turn.failed':
      job.turnFailed = true;
      job.diagnostic = diagnostics(event.error?.message) || job.diagnostic;
      job.phase = 'turn_failed';
      break;
    case 'error':
      job.diagnostic = diagnostics(event.message) || job.diagnostic;
      job.phase = 'cli_error';
      break;
    default:
      return;
  }
  if (job.phase.startsWith('item_')) {
    job.lastActivity = ACTIVITIES.get(event.item?.type) ?? 'processing_item';
  }
  job.events++;
  job.changedAt = Date.now();
}

export function createJobs({ projectDir, launcher }) {
  const jobs = new Map();
  const requests = new Map();
  let closed = false;
  let closePromise;

  function snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      model: job.model ?? null,
      reasoningEffort: job.reasoningEffort ?? null,
      phase: job.phase,
      lastActivity: job.lastActivity ?? null,
      events: job.events,
      itemsStarted: job.itemsStarted,
      itemsCompleted: job.itemsCompleted,
      elapsedMs: Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt),
      lastChangeAt: new Date(job.changedAt).toISOString(),
      ...(job.status === 'completed' && { answer: job.candidate }),
      ...(job.status === 'failed' && { error: job.error }),
    };
  }

  function lookup(id) {
    const job = jobs.get(id);
    if (!job) throw new Error('Unknown or expired job ID.');
    return job;
  }

  function prune() {
    for (const [id, job] of jobs) {
      if (jobs.size <= MAX_HISTORY) break;
      if (job.endedAt === undefined) continue;
      jobs.delete(id);
      requests.delete(job.requestId);
    }
  }

  function finish(job, status, error) {
    if (job.endedAt !== undefined) return;
    job.endedAt = Date.now();
    job.changedAt = job.endedAt;
    job.status = status;
    job.phase = status;
    job.error = error;
    if (status !== 'completed') job.candidate = undefined;
    job.child = undefined;
    job.resolveDone();
    prune();
  }

  function start({ prompt, model, reasoningEffort, requestId }) {
    if (closed) throw new Error('Codex dispatch is shutting down.');
    validate(prompt, model, reasoningEffort, requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify([prompt, model, reasoningEffort])).digest('hex');
    const previous = requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID already has different arguments.');
      return snapshot(previous);
    }
    if ([...jobs.values()].filter(job => job.endedAt === undefined).length >= MAX_ACTIVE) {
      throw new Error('Two Codex jobs are already active. Wait for one to finish.');
    }
    const startedAt = Date.now();
    const job = {
      id: randomUUID(), requestId, fingerprint, model, reasoningEffort,
      status: 'running', phase: 'launching', startedAt, changedAt: startedAt,
      events: 0, itemsStarted: 0, itemsCompleted: 0,
    };
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    jobs.set(job.id, job);
    requests.set(requestId, job);
    prune();

    let child;
    try {
      child = spawn(launcher.command, [...launcher.args, ...launchArguments(projectDir, model, reasoningEffort)], {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch {
      finish(job, 'failed', 'Codex could not be started.');
      return snapshot(job);
    }
    job.child = child;

    let pending = '';
    let oversizedLine = false;
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (job.status !== 'running') return;
      const parts = chunk.split('\n');
      for (const [index, part] of parts.entries()) {
        if (!oversizedLine && pending.length + part.length <= MAX_LINE_LENGTH) {
          pending += part;
        } else {
          oversizedLine = true;
          pending = '';
        }
        if (index < parts.length - 1) {
          if (!oversizedLine) readEvent(job, pending);
          pending = '';
          oversizedLine = false;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
    });
    child.stdin.on('error', () => {
      // A child that rejects the arguments can close stdin before exiting.
    });
    child.once('error', error => {
      if (job.status === 'cancelling') return;
      const message = error.code === 'ENOENT'
        ? 'Codex CLI or its working directory is unavailable.'
        : 'Codex could not be started.';
      finish(job, 'failed', message);
    });
    child.once('close', code => {
      if (job.status !== 'running') return;
      if (!oversizedLine && pending) readEvent(job, pending);
      if (code === 0 && job.turnCompleted && !job.turnFailed && job.candidate?.trim()) {
        finish(job, 'completed');
        return;
      }
      const reason = job.diagnostic || diagnostics(stderr);
      const fallback = job.oversizeAnswer ? 'Codex returned an answer above 512 KiB.'
        : code === 0 ? 'Codex ended without a completed answer.'
          : Number.isInteger(code) ? `Codex exited with status ${code}.`
            : 'The Codex process ended unexpectedly.';
      finish(job, 'failed', reason || fallback);
    });
    child.stdin.end(prompt, 'utf8');
    return snapshot(job);
  }

  function cancel(id) {
    const job = lookup(id);
    if (job.status === 'running') {
      job.status = 'cancelling';
      job.phase = 'cancelling';
      job.changedAt = Date.now();
      stopTree(job.child).then(
        () => finish(job, 'cancelled'),
        () => finish(job, 'failed', 'The Codex process tree could not be stopped.'),
      );
    }
    return snapshot(job);
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const active = [...jobs.values()].filter(job => job.endedAt === undefined);
    for (const job of active) cancel(job.id);
    closePromise = Promise.all(active.map(job => job.done)).then(() => undefined);
    return closePromise;
  }

  return { start, status: id => snapshot(lookup(id)), cancel, close };
}
