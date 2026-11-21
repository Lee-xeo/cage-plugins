import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stopTree } from './launch.mjs';

const discoveryTimeoutMs = 15_000;

function normalizeModel(model) {
  const id = typeof model?.model === 'string' && model.model.trim() ? model.model : model?.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Codex returned a model without an ID.');
  }
  return {
    id,
    displayName: model.displayName || id,
    reasoningEfforts: (model.supportedReasoningEfforts ?? [])
      .map(({ reasoningEffort }) => reasoningEffort)
      .filter((effort) => typeof effort === 'string'),
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    isDefault: model.isDefault === true,
  };
}

export async function listModels(launcher) {
  let child;
  try {
    child = spawn(launcher.command, [
      ...launcher.args, 'app-server', '--stdio', '--disable', 'hooks', '--disable', 'plugins',
      '--disable', 'apps',
    ], {
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch {
    throw new Error('Could not start Codex for model discovery.');
  }

  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const models = [];
    const cursors = new Set();
    let requestId = 1;
    let preferredModel;
    let preferredEffort;
    let finished = false;
    const timeout = setTimeout(
      () => finish(new Error('Codex model discovery timed out.'), true),
      discoveryTimeoutMs,
    );

    function stop() {
      void stopTree(child).catch(() => {});
    }

    function finish(error, timedOut = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      // On timeout, stop the process tree before closing the wrapper's stdin.
      if (timedOut) stop();
      child.stdin.end();
      if (!timedOut && child.pid && child.exitCode === null && child.signalCode === null) {
        const killTimer = setTimeout(stop, 500);
        killTimer.unref();
        child.once('close', () => clearTimeout(killTimer));
      }
      if (error) reject(error);
      else resolve(models);
    }

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }

    function requestPage(params) {
      send({ id: ++requestId, method: 'model/list', params });
    }

    child.on('error', () => finish(new Error('Could not start Codex for model discovery.')));
    child.stdin.on('error', () => finish(new Error('Could not communicate with Codex.')));
    child.stdout.on('error', () => finish(new Error('Could not communicate with Codex.')));
    child.once('close', () => finish(new Error('Codex exited before returning the model list.')));

    lines.on('line', (line) => {
      if (finished || !line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) {
            finish(new Error('Codex requested interaction during model discovery.'));
          }
          return;
        }
        if (message.id !== requestId) return;
        if (message.error || !message.result) {
          const errors = {
            1: 'Codex initialization failed.',
            2: 'Codex could not verify the model catalog configuration.',
          };
          finish(new Error(errors[requestId] ?? 'Codex could not list models.'));
          return;
        }
        if (requestId === 1) {
          send({ method: 'initialized' });
          send({ id: ++requestId, method: 'config/read', params: {} });
          return;
        }
        if (requestId === 2) {
          const { config } = message.result;
          if (!config || (config.model_provider != null && config.model_provider !== 'openai')) {
            finish(new Error('This version supports the built-in OpenAI provider only.'));
            return;
          }
          const api = (config.openai_base_url || '').replace(/\/+$/, '');
          const chat = (config.chatgpt_base_url || '').replace(/\/+$/, '');
          if ((api && api !== 'https://api.openai.com/v1') || (chat && chat !== 'https://chatgpt.com/backend-api')) {
            finish(new Error('This version does not dispatch through a custom provider endpoint.'));
            return;
          }
          if (config.model_catalog_json != null) {
            finish(new Error('Codex model discovery cannot use a custom model catalog.'));
            return;
          }
          preferredModel = config.model;
          preferredEffort = config.model_reasoning_effort;
          requestPage({ includeHidden: false });
          return;
        }

        const { data, nextCursor } = message.result;
        if (!Array.isArray(data)) throw new Error();
        for (const model of data) {
          if (!model?.hidden) models.push(normalizeModel(model));
        }
        if (nextCursor == null) {
          const preferred = models.find(m => m.id === preferredModel);
          if (preferred) {
            for (const model of models) model.isDefault = model === preferred;
            if (preferred.reasoningEfforts.includes(preferredEffort)) preferred.defaultReasoningEffort = preferredEffort;
          }
          finish();
          return;
        }
        if (typeof nextCursor !== 'string' || !nextCursor || cursors.has(nextCursor)) {
          throw new Error();
        }
        cursors.add(nextCursor);
        requestPage({ cursor: nextCursor, includeHidden: false });
      } catch {
        finish(new Error('Codex returned an invalid model discovery response.'));
      }
    });

    send({
      id: requestId,
      method: 'initialize',
      params: { clientInfo: { name: 'codex-dispatch', version: '0.1.2' } },
    });
  });
}
