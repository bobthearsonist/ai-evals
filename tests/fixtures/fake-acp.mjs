import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

const mode = process.env.FAKE_ACP_MODE ?? 'normal';
// Optional: hold each prompt open and append its start and end times to a
// shared log, so tests can observe whether sessions overlapped.
const holdMs = Number(process.env.FAKE_ACP_HOLD_MS ?? 0);
const logPrompt = (event) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify({ pid: process.pid, event, at: Date.now() })}\n`);
};
const app = agent({ name: 'fake-acp' });
let cancelPrompt;

app.onRequest(methods.agent.initialize, async ({ params }) => ({
  protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
  agentCapabilities: {},
  agentInfo: { name: 'fake-acp', version: String(process.pid) },
}));

app.onRequest(methods.agent.session.new, async () => ({
  sessionId: 'fake-session',
  configOptions: [{
    category: 'model',
    currentValue: 'synthetic-model',
    id: 'model',
    name: 'Model',
    type: 'select',
    options: mode === 'grouped-models'
      ? [{ group: 'Test models', options: [{ value: 'selected-model', name: 'Selected' }] }]
      : [{ value: 'synthetic-model', name: 'Synthetic' }, { value: 'selected-model', name: 'Selected' }],
  }],
}));

app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => ({
  configOptions: [{
    category: 'model',
    currentValue: params.value,
    id: 'model',
    name: 'Model',
    type: 'select',
    options: [{ value: params.value, name: 'Selected' }],
  }],
}));

app.onNotification(methods.agent.session.cancel, () => {
  cancelPrompt?.();
});

app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  logPrompt('start');
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  if (mode === 'error') throw new Error('synthetic ACP error');
  if (mode === 'auth-required') {
    // Mirrors the Claude adapter when the provider rejects a revoked OAuth token.
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Failed to authenticate: OAuth token revoked.' } },
    });
    throw RequestError.authRequired();
  }
  if (mode === 'timeout') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      cancelPrompt = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return { stopReason: 'cancelled' };
  }

  if (mode === 'permission') {
    await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'permission-1', title: 'Execute a command' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
    });
  }

  await client.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' }, messageId: 'm1' },
  });
  await client.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      name: 'Read',
      title: 'Read input',
      rawInput: { path: 'input.txt' },
      status: 'in_progress',
    },
  });
  await client.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: mode === 'blocked-inputs' ? 'failed' : 'completed',
      rawOutput: mode === 'blocked-inputs' ? 'Permission to use Read has been denied' : 'fixture data',
    },
  });
  await client.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' }, messageId: 'm1' },
  });
  if (mode !== 'unknown-usage') {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 17,
        size: 1000,
        cost: { amount: 0.002, currency: 'USD' },
      },
    });
  }
  logPrompt('end');
  return { stopReason: mode === 'refusal' ? 'refusal' : 'end_turn' };
});

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
