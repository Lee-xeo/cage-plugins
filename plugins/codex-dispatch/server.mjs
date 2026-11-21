import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { findCodex } from './launch.mjs';
import { createJobs } from './jobs.mjs';
import { listModels } from './models.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const textField = (description) => ({ type: 'string', minLength: 1, description });
const projectField = textField('Project key returned by codex_dispatch_models. Check its project name before dispatch.');
const jobField = textField('Task ID returned by codex_dispatch_start.');
const tools = [
  {
    name: 'codex_dispatch_models',
    description: 'Identify the open review project and list selectable Codex models and their reasoning efforts. Call before starting a task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'codex_dispatch_start',
    description: 'Start a read-only Codex review and return a task ID immediately. Use the requested model and reasoning effort, or omit both for the Codex review defaults. When tracking the result for the user, follow nextCheck if returned. With CronCreate available, schedule at most one one-shot check for this task in the current conversation, then continue other work. Confirm tracking only after scheduling succeeds.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['project', 'requestId', 'prompt'],
      properties: {
        project: projectField, requestId: textField('Unique request key (letters, digits, period, hyphen, underscore, colon). Reuse only when retrying the identical task.'),
        prompt: textField('Brief, self-contained review question. Mention relevant project files by relative path.'),
        model: textField('Exact selectable model ID returned by codex_dispatch_models.'),
        reasoningEffort: textField('Reasoning effort supported by the selected model. Explicitly select a model when setting effort.'),
      },
    },
  },
  {
    name: 'codex_dispatch_progress',
    description: 'Check a task yourself. Returns observed progress, elapsed time, and the answer when finished. Set waitSeconds to wait briefly for a change. A running task includes nextCheck for a later one-shot status check.',
    inputSchema: {
      type: 'object', required: ['jobId'], additionalProperties: false,
      properties: { jobId: jobField, waitSeconds: { type: 'integer', minimum: 0, maximum: 12 } },
    },
  },
  {
    name: 'codex_dispatch_cancel',
    description: 'Stop a running review by task ID. Use progress to check its final state.',
    inputSchema: { type: 'object', properties: { jobId: jobField }, required: ['jobId'], additionalProperties: false },
  },
];

const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir) || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Open a shared project folder before starting Codex Dispatch.');
  process.exit(1);
}
const projectDir = realpathSync(dir);
const project = randomUUID();
let jobs;
let launcher;
let cachedModels;
let modelsInFlight;
let closing = false;

function getLauncher() {
  return launcher ??= findCodex({ projectDir });
}
function getModels() {
  if (cachedModels && Date.now() < cachedModels.expires) return cachedModels.value;
  return modelsInFlight ??= listModels(getLauncher()).then((value) => {
    cachedModels = { expires: Date.now() + 60_000, value };
    return value;
  }).finally(() => { modelsInFlight = undefined; });
}
function validate(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an object with tool arguments.');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error('Unexpected tool argument.');
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new Error('Missing required argument: ' + key);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key];
    if (spec.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new Error('Expected non-empty text for ' + key);
    if (spec.type === 'integer' && (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error('Invalid range for ' + key);
  }
}
function taskStatus(jobId) {
  if (!jobs) throw new Error('No matching task in the active project session.');
  return jobs.status(jobId);
}
function withNextCheck(state) {
  if (state.status !== 'running') return state;
  return {
    ...state,
    nextCheck: {
      afterMinutes: state.elapsedMs < 120_000 ? 1 : 2,
      recurring: false,
      prompt: `Call codex_dispatch_progress with jobId "${state.id}". If still running, use nextCheck to arrange one later check in this session unless one is already pending. Otherwise report the outcome and stop. If the task is unavailable or permission is denied, stop tracking it.`,
    },
  };
}
async function callTool(name, args) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error('Unknown tool.');
  validate(tool, args);
  if (name === 'codex_dispatch_models') {
    const context = { project, projectName: path.basename(projectDir) };
    try {
      return { ...context, models: await getModels() };
    } catch (error) {
      return { ...context, models: [], discoveryError: error.message };
    }
  }
  if (name === 'codex_dispatch_start') {
    if (args.project !== project) throw new Error('The selected project has changed. Check the active project before starting a new task.');
    if (args.reasoningEffort && !args.model) throw new Error('Select a model when setting reasoning effort.');
    const catalog = await getModels();
    const selected = args.model ? catalog.find(m => m.id === args.model) : catalog.find(m => m.isDefault);
    if (args.model && !selected) throw new Error('Model is not in the current Codex model list.');
    if (args.reasoningEffort && !selected.reasoningEfforts.includes(args.reasoningEffort)) throw new Error('This model does not offer that reasoning effort.');
    if (closing) throw new Error('The review service is shutting down.');
    jobs ??= createJobs({ projectDir, launcher: getLauncher() });
    return withNextCheck(jobs.start({
      prompt: args.prompt, requestId: args.requestId,
      model: selected?.id, reasoningEffort: args.reasoningEffort ?? selected?.defaultReasoningEffort ?? undefined,
    }));
  }
  if (name === 'codex_dispatch_cancel') {
    taskStatus(args.jobId);
    return jobs.cancel(args.jobId);
  }
  let state = taskStatus(args.jobId);
  const since = state.lastChangeAt;
  const deadline = Date.now() + (args.waitSeconds ?? 0) * 1000;
  while (!closing && Date.now() < deadline && ['running', 'cancelling'].includes(state.status) && since === state.lastChangeAt) {
    await sleep(Math.min(200, deadline - Date.now()));
    state = taskStatus(args.jobId);
  }
  return withNextCheck(state);
}

function respond(id, message) {
  if (!closing) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
}
async function receive(line) {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return respond(null, { error: { code: -32700, message: 'Invalid JSON.' } });
  }
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return respond(null, { error: { code: -32600, message: 'Invalid request.' } });
  if (!Object.hasOwn(req, 'id')) return;
  const { id, method, params } = req;
  if (method === 'initialize') {
    return respond(id, { result: {
      protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} }, serverInfo: { name: 'codex-dispatch', version: '0.1.2' },
    } });
  }
  if (method === 'ping') return respond(id, { result: {} });
  if (method === 'tools/list') return respond(id, { result: { tools } });
  if (method !== 'tools/call') return respond(id, { error: { code: -32601, message: 'Unknown method.' } });
  try {
    const result = await callTool(params?.name, params?.arguments ?? {});
    respond(id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  } catch (error) {
    respond(id, { result: { isError: true, content: [{ type: 'text', text: error.message }] } });
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => { void receive(line); });
async function shutdown() {
  if (closing) return;
  closing = true;
  reader.close();
  await jobs?.close();
}
reader.on('close', () => { void shutdown(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().then(() => process.exit(0)); });
