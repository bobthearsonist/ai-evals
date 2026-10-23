import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client as createClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { buildAcpLaunch, isBuiltAcpLaunch, validateAcpProfile } from './acp-profiles.mjs';
import { prepareAcpEnvironment } from './acp-isolation.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function contextualizeExecutionErrors(options, errors) {
  const client = options.client ?? 'unknown';
  const profile = options.profile ?? 'default';
  const context = `ACP client ${client} (profile ${profile}) using executable "${options.command}" from "${options.cwd}"`;
  return errors.map((error) => {
    const normalized = asError(error);
    return normalized.message.includes(context)
      ? normalized
      : new Error(`${context}: ${normalized.message}`, { cause: normalized });
  });
}

function describeLaunchError(options, error) {
  const client = options.client ?? 'unknown';
  const profile = options.profile ?? 'default';
  return new Error(
    `Unable to start ACP client ${client} (profile ${profile}) using executable "${options.command}" from "${options.cwd}": ${asError(error).message}. Verify the executable exists and is available at that path or on PATH.`,
    { cause: asError(error) },
  );
}

function normalizedUsage() {
  return {
    inputTokens: null,
    outputTokens: null,
    context: null,
    cost: null,
    known: false,
  };
}

function getModelFromConfigOptions(configOptions) {
  const modelOption = configOptions?.find((option) => option.category === 'model' || option.id === 'model');
  return modelOption?.currentValue ?? null;
}

function updateToolCalls(toolCalls, update) {
  const id = update.toolCallId;
  if (!id) return;
  const existing = toolCalls.get(id) ?? { id };
  Object.assign(existing, update);
  toolCalls.set(id, existing);
}

function toResult({ text, toolCalls, raw, complete, usage, model, stopReason, errors }) {
  return Object.freeze({
    finalText: text,
    toolCalls: Object.freeze([...toolCalls.values()].map((call) => freezeDeep({ ...call }))),
    raw: Object.freeze(raw.map((event) => freezeDeep(event))),
    complete,
    usage: freezeDeep(usage),
    model: model ?? null,
    stopReason: stopReason ?? null,
    errors: Object.freeze(errors.map((error) => (typeof error === 'string' ? error : error.message))),
  });
}

function record(raw, event) {
  raw.push(structuredClone(event));
}

function requestPermissionHandler(raw) {
  return async ({ method, params }) => {
    record(raw, { direction: 'in', method, params });
    const response = { outcome: { outcome: 'cancelled' } };
    record(raw, { direction: 'out', method, result: response });
    return response;
  };
}

async function terminateChild(child, closePromise) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill('SIGTERM');
  await Promise.race([closePromise, delay(400)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([closePromise, delay(400)]);
  }
  return true;
}

function assertExecutionOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('ACP execution options are required');
  if (!isBuiltAcpLaunch(options)) throw new Error('ACP execution options must come from buildAcpLaunch');
  if (typeof options.command !== 'string' || !options.command) throw new TypeError('ACP command is required');
  if (!Array.isArray(options.args)) throw new TypeError('ACP args must be an array');
  if (typeof options.cwd !== 'string' || !options.cwd) throw new TypeError('ACP cwd is required');
  if (typeof options.prompt !== 'string' || !options.prompt) throw new TypeError('ACP prompt is required');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new TypeError('ACP timeoutMs must be positive');

  if (options.mode === 'judge') {
    const isolation = options.judgeIsolation;
    if (
      options.profile !== 'ai-evals-judge' ||
      isolation?.profile !== 'ai-evals-judge' ||
      isolation?.enforced !== true ||
      isolation?.tools !== false ||
      isolation?.skills !== false ||
      isolation?.mcp !== false
    ) {
      throw new Error('Judge ACP execution requires the built-in ai-evals-judge profile');
    }
  }
}

export {
  buildAcpLaunch,
  validateAcpProfile,
};

export async function executeAcp(options) {
  assertExecutionOptions(options);
  const isolated = options.isolatedClient ? prepareAcpEnvironment(options.isolatedClient) : null;
  try {
    return await executeConfiguredAcp(options, isolated?.env ?? { ...process.env, ...(options.env ?? {}) });
  } finally {
    isolated?.cleanup();
  }
}

async function executeConfiguredAcp(options, environment) {
  const raw = [];
  const errors = [];
  const text = [];
  const toolCalls = new Map();
  const usage = normalizedUsage();
  let model = null;
  let stopReason = null;
  let sessionId = null;
  let context = null;
  let timedOut = false;
  let stderr = '';

  let child;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const launchError = describeLaunchError(options, error);
    record(raw, { direction: 'error', phase: 'spawn', message: launchError.message });
    return toResult({ text: '', toolCalls, raw, complete: false, usage, model, stopReason, errors: [launchError] });
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const spawnPromise = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    await spawnPromise;
  } catch (error) {
    const launchError = describeLaunchError(options, error);
    record(raw, { direction: 'error', phase: 'spawn', message: launchError.message });
    await closePromise;
    return toResult({ text: '', toolCalls, raw, complete: false, usage, model, stopReason, errors: [launchError] });
  }

  const app = createClient({ name: 'ai-evals', version: '0.1.1' });
  app.onRequest(methods.client.session.requestPermission, requestPermissionHandler(raw));
  app.onNotification(methods.client.session.update, ({ method, params }) => {
    record(raw, { direction: 'in', method, params });
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      text.push(update.content.text);
    } else if (update.sessionUpdate === 'tool_call') {
      updateToolCalls(toolCalls, update);
    } else if (update.sessionUpdate === 'tool_call_update') {
      updateToolCalls(toolCalls, update);
    } else if (update.sessionUpdate === 'usage_update') {
      usage.context = { used: update.used, size: update.size };
      usage.cost = update.cost ?? null;
      usage.known = true;
    }
  });

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  let connectionFinished = false;
  let timer;
  let stoppedByTransport = false;
  const operation = app.connectWith(stream, async (cx) => {
    context = cx;
    const request = async (method, params) => {
      record(raw, { direction: 'out', method, params });
      try {
        const response = await cx.request(method, params);
        record(raw, { direction: 'in', method, result: response });
        return response;
      } catch (error) {
        record(raw, { direction: 'error', method, message: asError(error).message });
        throw error;
      }
    };
    const notify = async (method, params) => {
      record(raw, { direction: 'out', method, params });
      await cx.notify(method, params);
    };

    const initialized = await request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'ai-evals', version: '0.1.1' },
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`ACP agent negotiated unsupported protocol version ${initialized.protocolVersion}`);
    }
    if (options.expectedAgentVersion && initialized.agentInfo?.version !== options.expectedAgentVersion) {
      throw new Error(`ACP profile ${options.profile} requires agent ${options.expectedAgentVersion}; received ${initialized.agentInfo?.version ?? 'no version'}`);
    }

    const created = await request(methods.agent.session.new, {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
      ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
    });
    sessionId = created.sessionId;
    model = getModelFromConfigOptions(created.configOptions);

    if (options.model && model !== options.model) {
      const modelOption = created.configOptions?.find((option) => option.category === 'model' || option.id === 'model');
      const knownValues = modelOption?.options?.flatMap((entry) => ('options' in entry ? entry.options : [entry])) ?? [];
      if (modelOption && knownValues.some((option) => option.value === options.model)) {
        const configured = await request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: modelOption.id,
          value: options.model,
        });
        const configuredModel = getModelFromConfigOptions(configured.configOptions);
        if (options.isolatedClient && configuredModel !== options.model) {
          throw new Error(`ACP adapter did not confirm model ${options.model}`);
        }
        model = configuredModel ?? options.model;
      } else if (options.modelAtLaunch) {
        if (options.isolatedClient) {
          throw new Error(`ACP adapter did not confirm model ${options.model}`);
        }
        model = options.model;
      } else {
        throw new Error(`ACP agent did not expose a selectable model option for ${options.model}`);
      }
    } else {
      model = getModelFromConfigOptions(created.configOptions);
    }

    const promptParams = {
      sessionId,
      prompt: [{ type: 'text', text: options.prompt }],
    };
    record(raw, { direction: 'out', method: methods.agent.session.prompt, params: promptParams });
    const response = await cx.request(methods.agent.session.prompt, promptParams);
    record(raw, { direction: 'in', method: methods.agent.session.prompt, result: response });
    stopReason = response.stopReason;
    return response;
  });

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      resolve({ timeout: true });
      if (context && sessionId) {
        try {
          const params = { sessionId };
          record(raw, { direction: 'out', method: methods.agent.session.cancel, params });
          await context.notify(methods.agent.session.cancel, params);
        } catch {
          // Closing the transport below remains the hard stop if cancellation fails.
        }
      }
    }, options.timeoutMs);
    timer.unref?.();
  });

  let complete = false;
  try {
    const outcome = await Promise.race([
      operation.then((response) => ({ response })),
      timeoutPromise,
    ]);
    if (outcome.timeout) {
      errors.push(new Error(`ACP prompt exceeded timeout of ${options.timeoutMs}ms; increase the timeout if this duration is expected or verify the ACP client is responsive`));
      record(raw, { direction: 'error', phase: 'timeout', timeoutMs: options.timeoutMs });
      await Promise.race([operation.catch(() => undefined), delay(250)]);
    } else {
      connectionFinished = true;
      stopReason = outcome.response.stopReason;
      complete = stopReason === 'end_turn';
      if (!complete) errors.push(new Error(`ACP prompt ended with stop reason: ${stopReason}`));
    }
  } catch (error) {
    const protocolError = asError(error);
    errors.push(protocolError);
    record(raw, { direction: 'error', phase: 'protocol', message: protocolError.message });
  } finally {
    clearTimeout(timer);
    stoppedByTransport = await terminateChild(child, closePromise);
    if (!stoppedByTransport && child.exitCode !== null && child.exitCode !== 0) {
      errors.push(new Error(`ACP process exited with code ${child.exitCode}`));
    }
  }

  const exit = await closePromise;
  if (!stoppedByTransport && !timedOut && !connectionFinished && (exit.code !== 0 || exit.signal)) {
    errors.push(new Error(`ACP process exited before completion (code=${exit.code}, signal=${exit.signal ?? 'none'})`));
  }
  if (stderr.trim() && errors.length) {
    record(raw, { direction: 'stderr', message: stderr.trim() });
  }
  if (options.mode === 'judge' && toolCalls.size > 0) {
    errors.push(new Error('Judge ACP profile emitted tool calls despite its tool-free configuration'));
    complete = false;
    record(raw, { direction: 'error', phase: 'judge-isolation', message: 'tool calls observed in judge session' });
  }

  return toResult({
    text: text.join(''), toolCalls, raw, complete: complete && errors.length === 0, usage, model, stopReason,
    errors: contextualizeExecutionErrors(options, errors),
  });
}
