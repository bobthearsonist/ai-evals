import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMcp, runSdkSession, sdkSessionConfig } from '../local/copilot-sdk.mjs';
import { createLegacyCopilotRunner as createCopilotRunner, parseCopilotTrace } from '../local/copilot.mjs';

function setup(t, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'copilot-sdk-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const skillsRoot = join(workspace, '.github', 'skills');
  const skillPath = join(skillsRoot, 'demo');
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(join(skillPath, 'SKILL.md'), 'demo');
  const request = {
    workspace, skillsRoot, model: 'synthetic', maxAiCredits: 30, timeoutMs: 1000,
    expected: { name: 'demo', path: skillPath }, prompt: 'hello',
    auditPath: join(root, 'before.json'), postAuditPath: join(root, 'after.json'),
    startedPath: join(root, 'started'), usagePath: join(root, 'usage.json'),
  };
  const calls = [];
  let config;
  let lists = 0;
  const session = {
    rpc: {
      options: { update: async (options) => { calls.push(['limits', options]); return { success: mode !== 'limits' }; } },
      skills: { list: async () => {
        lists++;
        calls.push(['list', lists]);
        const bad = mode === 'before' || (mode === 'after' && lists === 2);
        return { skills: [{ name: bad ? 'foreign' : 'demo', path: skillPath, enabled: true }] };
      } },
      mcp: { listConfigured: async () => {
        calls.push(['mcp']);
        return { servers: mode === 'mcp' ? [{ name: 'github-mcp-server', enabled: true, live: { status: 'connected' } }] : [] };
      } },
      usage: { getMetrics: async () => { calls.push(['usage']); return mode === 'usage' ? null : { totalNanoAiu: 100 }; } },
    },
    sendAndWait: async (message, timeout) => {
      calls.push(['send', message, timeout]);
      assert.equal(existsSync(request.startedPath), true);
      if (mode === 'send') throw new Error('synthetic send failed');
      if (mode === 'runtime-mcp') config.onEvent({ type: 'session.mcp_server_status_changed', data: { serverName: 'foreign', status: 'connected' } });
      for (const [type, data] of [
        ['tool.execution_start', { toolName: 'skill', toolCallId: 's', arguments: { skill: 'demo' } }],
        ['tool.execution_complete', { toolCallId: 's', success: true }],
        ['assistant.message', { content: 'hello' }],
        ['session.idle', {}],
      ]) config.onEvent({ type, data });
    },
    disconnect: async () => { calls.push(['disconnect']); if (mode === 'disconnect') throw new Error('synthetic disconnect failed'); },
  };
  const client = {
    start: async () => { calls.push(['start']); },
    createSession: async (options) => {
      calls.push(['create']);
      config = options;
      if (mode === 'create') throw new Error('synthetic create failed');
      if (mode === 'disabled-mcp-runtime') {
        options.onEvent({ type: 'session.mcp_server_status_changed', data: { serverName: 'github-mcp-server', status: 'disabled' } });
        options.onEvent({ type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'github-mcp-server', status: 'disabled', source: 'builtin' }] } });
      }
      return session;
    },
    stop: async () => { calls.push(['stop']); return mode === 'stop' ? [new Error('synthetic stop failed')] : []; },
  };
  return { root, request, calls, client };
}

test('SDK session audits exact catalog before and after one bounded send and archives native events and usage', async (t) => {
  const x = setup(t);
  const events = [];
  await runSdkSession(x.request, x.client, (event) => events.push(event));
  assert.deepEqual(x.calls.map(([name]) => name), ['start', 'create', 'limits', 'list', 'mcp', 'send', 'list', 'mcp', 'usage', 'disconnect', 'stop']);
  assert.deepEqual(x.calls.find(([name]) => name === 'limits')[1], { sessionLimits: { maxAiCredits: 30 } });
  assert.deepEqual(x.calls.find(([name]) => name === 'send').slice(1), [{ prompt: 'hello' }, 1000]);
  assert.deepEqual(JSON.parse(readFileSync(x.request.usagePath, 'utf8')), { totalNanoAiu: 100 });
  assert.equal(JSON.parse(readFileSync(x.request.auditPath, 'utf8')).skills.length, 1);
  assert.equal(JSON.parse(readFileSync(x.request.postAuditPath, 'utf8')).skills.length, 1);
  const parsed = parseCopilotTrace(events.map((event) => JSON.stringify(event)).join('\n'));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.skillInvocations[0].name, 'demo');
  assert.equal(parsed.runtimeSkills, null); // RPC audit is archived separately, never fabricated as a native event.
});

test('SDK failures never retry or send before limits and catalog acceptance, and always stop runtime', async (t) => {
  for (const mode of ['create', 'limits', 'before', 'mcp', 'send', 'after', 'runtime-mcp', 'usage', 'disconnect', 'stop']) {
    await t.test(mode, async (t) => {
      const x = setup(t, mode);
      await assert.rejects(runSdkSession(x.request, x.client, () => {}));
      const attempted = !['create', 'limits', 'before', 'mcp'].includes(mode);
      assert.equal(x.calls.filter(([name]) => name === 'send').length, attempted ? 1 : 0);
      assert.equal(existsSync(x.request.startedPath), attempted);
      assert.equal(x.calls.at(-1)[0], 'stop');
      assert.equal(existsSync(x.request.usagePath), ['disconnect', 'stop'].includes(mode));
    });
  }
});

test('SDK baseline accepts an empty catalog, not a silently enabled foreign skill', async (t) => {
  const x = setup(t);
  x.request.expected = null;
  await assert.rejects(runSdkSession(x.request, x.client, () => {}), /expected no enabled skills/);
  assert.equal(existsSync(x.request.startedPath), false);
  const y = setup(t);
  y.request.expected = null;
  y.client.createSession = async () => ({
    rpc: {
      options: { update: async () => ({ success: true }) },
      skills: { list: async () => ({ skills: [] }) },
      mcp: { listConfigured: async () => ({ servers: [] }) },
      usage: { getMetrics: async () => ({ totalNanoAiu: 1 }) },
    },
    sendAndWait: async () => {},
    disconnect: async () => {},
  });
  await runSdkSession(y.request, y.client, () => {});
  assert.equal(existsSync(y.request.startedPath), true);
});

test('SDK configuration excludes ambient instructions, bundled skills, hooks and non-read tools without disabling native login', (t) => {
  const x = setup(t);
  const config = sdkSessionConfig(x.request, () => {});
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.enableSkills, true);
  assert.deepEqual(config.includedBuiltinSkills, []);
  assert.deepEqual(config.skillDirectories, [x.request.skillsRoot]);
  assert.deepEqual(config.availableTools, ['builtin:skill', 'builtin:view', 'builtin:glob', 'builtin:rg']);
  assert.equal(config.skipCustomInstructions, true);
  for (const key of ['enableOnDemandInstructionDiscovery', 'enableFileHooks', 'enableHostGitOperations', 'enableSessionStore']) assert.equal(config[key], false);
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.disabledMcpServers, ['github-mcp-server']);
  assert.equal(config.remoteSession, 'off');
  assert.equal('gitHubToken' in config, false);
  assert.equal('mode' in config, false);
  const permission = config.onPermissionRequest;
  const file = join(x.request.expected.path, 'SKILL.md');
  assert.deepEqual(permission({ kind: 'read', path: file }), { kind: 'approved' });
  for (const p of [
    { kind: 'read', path: x.request.auditPath },
    { kind: 'read', path: x.root },
    { kind: 'read', path: file, managedApprovalRequired: true },
    { kind: 'read', path: file, requestSandboxBypass: true },
    { kind: 'read', path: 'missing' },
    { kind: 'read' }, { kind: 'shell' }, { kind: 'write', path: file }, { kind: 'mcp' }, { kind: 'url' },
  ]) assert.deepEqual(permission(p), { kind: 'denied-by-rules' });
  const escape = join(x.request.workspace, 'escape');
  symlinkSync(x.root, escape, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(permission({ kind: 'read', path: escape }), { kind: 'denied-by-rules' });
});

test('SDK MCP audit rejects enabled, connected or malformed inventories', () => {
  assert.doesNotThrow(() => auditMcp({ servers: [] }));
  assert.doesNotThrow(() => auditMcp({ servers: [{ name: 'github-mcp-server', enabled: false, live: { status: 'disabled' } }] }));
  for (const value of [{}, { servers: [{}] }, { servers: [{ name: 'foreign', enabled: true }] },
    { servers: [{ name: 'foreign', enabled: false, live: { status: 'connected' } }] },
    { servers: [{ name: 'foreign', enabled: false, live: { status: 'pending' } }] }]) {
    assert.throws(() => auditMcp(value), /MCP/);
  }
});

test('SDK accepts only explicitly inactive built-in MCP status events', async (t) => {
  const x = setup(t, 'disabled-mcp-runtime');
  await runSdkSession(x.request, x.client, () => {});
  assert.equal(x.calls.filter(([name]) => name === 'send').length, 1);
});

test('SDK is the default and cannot silently reinterpret wrapper prefix arguments', () => {
  assert.throws(() => createCopilotRunner({ exe: process.execPath, prefixArgs: ['fake.mjs'] }), /native executable/);
  assert.throws(() => createCopilotRunner({ transport: 'other' }), /unknown Copilot transport/);
});
