import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcpLaunch, executeAcp, validateAcpProfile } from '../local/acp.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fake = resolve(import.meta.dirname, 'fixtures', 'fake-acp.mjs');

function fakeOptions(mode = 'normal', overrides = {}) {
  return buildAcpLaunch({
    client: 'custom',
    profile: 'custom',
    mode: 'candidate',
    command: process.execPath,
    args: [fake],
    cwd: root,
    prompt: 'Respond with a synthetic result.',
    timeoutMs: 2_000,
    env: { FAKE_ACP_MODE: mode },
    ...overrides,
  });
}

async function assertProcessStopped(result) {
  const init = result.raw.find((event) => event.method === 'initialize' && event.result?.agentInfo?.name === 'fake-acp');
  assert.ok(init, 'fake agent initialization must be captured');
  const pid = Number(init.result.agentInfo.version);
  assert.ok(Number.isInteger(pid) && pid > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => process.kill(pid, 0));
}

test('buildAcpLaunch creates a side-effect-free launch and frozen judge isolation profile', () => {
  const valid = validateAcpProfile({
    client: 'claude',
    mode: 'judge',
    profile: 'ai-evals-judge',
    cwd: root,
    model: 'claude-test-model',
    requiredCapabilities: ['tool-exclusion', 'skill-exclusion', 'mcp-exclusion', 'fixed-model'],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.mode, 'judge');
  assert.deepEqual(valid.judgeIsolation, {
    profile: 'ai-evals-judge',
    enforced: true,
    tools: false,
    skills: false,
    mcp: false,
  });
  assert.equal(valid.command, process.execPath);
  assert.match(valid.args[0], /local[\\/]claude-acp.mjs$/);
  assert.deepEqual(valid.mcpServers, []);
  assert.equal(valid.sessionMeta.disableBuiltInTools, true);
  assert.deepEqual(valid.sessionMeta.claudeCode.options.tools, []);
  assert.deepEqual(valid.sessionMeta.claudeCode.options.skills, []);
  assert.deepEqual(valid.sessionMeta.claudeCode.options.settingSources, []);
  assert.equal(valid.sessionMeta.claudeCode.options.strictMcpConfig, true);
  assert.equal(valid.sessionMeta.claudeCode.options.model, 'claude-test-model');
  assert.equal(valid.expectedAgentVersion, '0.94.0');

  assert.equal(validateAcpProfile({ client: 'copilot', mode: 'judge', profile: 'copilot', cwd: root, model: 'x' }).valid, false);
  assert.equal(validateAcpProfile({ client: 'copilot', mode: 'candidate', cwd: root, requiredCapabilities: ['mcp-free'] }).valid, true);
  for (const client of ['copilot', 'claude']) {
    const candidate = validateAcpProfile({ client, mode: 'candidate', cwd: root, model: 'candidate-model', skillName: 'demo' });
    assert.equal(candidate.valid, true, candidate.errors.join(';'));
    assert.equal(candidate.isolatedClient, client);
    assert.equal(candidate.capabilities.mcpFree, true);
    assert.deepEqual(candidate.mcpServers, []);
    assert.equal(validateAcpProfile({ client, cwd: root, env: { HOME: 'ambient' } }).valid, false);
    assert.equal(validateAcpProfile({ client, cwd: root, sessionMeta: { override: true } }).valid, false);
    assert.equal(validateAcpProfile({ client, cwd: root, args: ['--unsafe'] }).valid, false);
    if (client === 'claude') {
      assert.deepEqual(candidate.sessionMeta.claudeCode.options.settingSources, ['project']);
      assert.deepEqual(candidate.sessionMeta.claudeCode.options.skills, ['demo']);
      assert.deepEqual(candidate.sessionMeta.claudeCode.options.tools, ['Read', 'Glob', 'Grep', 'Skill']);
      assert.equal(candidate.sessionMeta.claudeCode.options.strictMcpConfig, true);
    } else {
      for (const flag of ['--no-custom-instructions', '--disable-builtin-mcps', '--no-auto-update', '--no-bash-env']) {
        assert.ok(candidate.args.includes(flag), flag);
      }
      assert.ok(candidate.args.includes('skill'));
    }
  }
  assert.equal(validateAcpProfile({ client: 'opencode', cwd: root }).valid, false);
  assert.throws(() => buildAcpLaunch({
    client: 'claude', mode: 'judge', profile: 'ai-evals-judge', cwd: root, model: 'x',
    sessionMeta: { disableBuiltInTools: false },
  }), /does not allow overriding/);
  assert.throws(() => buildAcpLaunch({
    client: 'claude', mode: 'judge', profile: 'ai-evals-judge', cwd: root, model: 'x',
    mcpServers: [{ name: 'ambient', type: 'http', url: 'https://example.invalid' }],
  }), /does not allow ACP MCP servers/);
  assert.throws(() => buildAcpLaunch({
    client: 'claude', mode: 'judge', profile: 'ai-evals-judge', cwd: root, model: 'x',
    sessionMeta: { claudeCode: { options: { mcpServers: [{ name: 'ambient' }] } } },
  }), /does not allow claudeCode.options.mcpServers/);
  assert.throws(() => buildAcpLaunch({
    client: 'opencode', mode: 'candidate', profile: 'opencode', cwd: root,
    prompt: 'p', requiredCapabilities: ['mcp-free'],
  }), /does not provide required capability: mcp-free/);
});

test('missing ACP executable returns an actionable client, profile and path error', async () => {
  const executable = resolve(root, 'missing-acp.exe');
  const result = await executeAcp(fakeOptions('normal', { command: executable }));
  assert.equal(result.complete, false);
  assert.match(result.errors.join('; '), /ACP client custom \(profile custom\)/);
  assert.ok(result.errors.join('; ').includes(executable));
  assert.match(result.errors.join('; '), /Verify the executable exists/);
});

test('real ACP child process streams text, tool calls, usage and protocol events', async () => {
  const result = await executeAcp(fakeOptions());
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.finalText, 'hello world');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0], {
    id: 'tool-1',
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    name: 'Read',
    title: 'Read input',
    rawInput: { path: 'input.txt' },
    status: 'completed',
    rawOutput: 'fixture data',
  });
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: null,
    context: { used: 17, size: 1000 },
    cost: { amount: 0.002, currency: 'USD' },
    known: true,
  });
  assert.ok(result.raw.some((event) => event.method === 'initialize' && event.direction === 'out'));
  assert.ok(result.raw.some((event) => event.method === 'session/new'));
  assert.ok(result.raw.some((event) => event.method === 'session/prompt'));
  assert.ok(Object.isFrozen(result.raw));
  assert.ok(Object.isFrozen(result.raw[0]));
  await assertProcessStopped(result);
});

test('permissions are denied by default; unknown usage is null rather than fabricated zero', async () => {
  const permission = await executeAcp(fakeOptions('permission'));
  assert.equal(permission.complete, true);
  const request = permission.raw.find((event) => event.method === 'session/request_permission');
  assert.ok(request);
  assert.ok(permission.raw.some((event) => event.direction === 'in' && event.method === 'session/request_permission'));
  assert.ok(permission.raw.some((event) => (
    event.direction === 'out' &&
    event.method === 'session/request_permission' &&
    event.result?.outcome?.outcome === 'cancelled'
  )));
  assert.deepEqual(permission.usage, {
    inputTokens: null,
    outputTokens: null,
    context: { used: 17, size: 1000 },
    cost: { amount: 0.002, currency: 'USD' },
    known: true,
  });

  const unknown = await executeAcp(fakeOptions('unknown-usage'));
  assert.equal(unknown.complete, true);
  assert.deepEqual(unknown.usage, {
    inputTokens: null,
    outputTokens: null,
    context: null,
    cost: null,
    known: false,
  });
  await assertProcessStopped(permission);
  await assertProcessStopped(unknown);
});

test('protocol errors and abnormal stop reasons fail the ACP completion result', async () => {
  const errored = await executeAcp(fakeOptions('error'));
  assert.equal(errored.complete, false);
  assert.ok(errored.errors.length > 0);

  const refused = await executeAcp(fakeOptions('refusal'));
  assert.equal(refused.complete, false);
  assert.equal(refused.stopReason, 'refusal');
  assert.match(refused.errors.join(' '), /stop reason: refusal/);
  await assertProcessStopped(errored);
  await assertProcessStopped(refused);
});

test('deadline sends session/cancel and reaps the child process', async () => {
  const timed = await executeAcp(fakeOptions('timeout', { timeoutMs: 2_500 }));
  assert.equal(timed.complete, false);
  assert.equal(timed.stopReason, 'cancelled');
  assert.ok(timed.raw.some((event) => event.direction === 'out' && event.method === 'session/cancel'));
  assert.match(timed.errors.join(' '), /timeout/);
  await assertProcessStopped(timed);
});

test('model selection uses ACP session config options and execution validates required inputs', async () => {
  const result = await executeAcp(fakeOptions('normal', { model: 'selected-model' }));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.model, 'selected-model');
  assert.ok(result.raw.some((event) => event.method === 'session/set_config_option'));
  const selection = result.raw.find((event) => event.method === 'session/set_config_option' && event.direction === 'out');
  assert.equal(selection.params.value, 'selected-model');
  await assert.rejects(
    executeAcp({
      command: 'x',
      args: [],
      cwd: root,
      prompt: 'p',
      timeoutMs: 10,
      mode: 'judge',
      profile: 'ai-evals-judge',
      judgeIsolation: { profile: 'ai-evals-judge', enforced: true, tools: false, skills: false, mcp: false },
    }),
    /must come from buildAcpLaunch/,
  );
});

test('ACP model selection handles grouped values and refuses unavailable models before prompting', async () => {
  const grouped = await executeAcp(fakeOptions('grouped-models', { model: 'selected-model' }));
  assert.equal(grouped.complete, true, JSON.stringify(grouped.errors));
  assert.equal(grouped.model, 'selected-model');
  const unavailable = await executeAcp(fakeOptions('normal', { model: 'unavailable-model' }));
  assert.equal(unavailable.complete, false);
  assert.match(unavailable.errors.join('; '), /did not expose a selectable model/);
  assert.equal(unavailable.raw.some((event) => event.method === 'session/prompt'), false);
  await assertProcessStopped(grouped);
  await assertProcessStopped(unavailable);
});
