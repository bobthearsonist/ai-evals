import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoManagedClaudeSettings, checkAcpRuntime, prepareAcpEnvironment, readCopilotInstructionEvidence, resolveAcpCredentials } from '../local/acp-isolation.mjs';

test('instruction delivery requires native model-input events, not staged bytes or tool output', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-instructions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd: root, copilotHome: root, sessionId: 'native-session' };
  assert.equal(readCopilotInstructionEvidence(options).status, 'not-configured');
  writeFileSync(join(root, 'AGENTS.md'), 'Use the coordination protocol.\r\n');
  assert.equal(readCopilotInstructionEvidence(options).status, 'unavailable');
  const directory = join(root, 'session-state', options.sessionId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'events.jsonl');
  const writeEvents = (events) => writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n'));
  writeEvents([{ type: 'tool.execution_complete', data: { role: 'system', content: 'Use the coordination protocol.' } }]);
  assert.equal(readCopilotInstructionEvidence(options).status, 'unavailable');
  const event = { type: 'system.message', data: { role: 'developer', content: 'Instructions:\nUse the coordination protocol.\n' } };
  writeEvents([event]);
  const result = readCopilotInstructionEvidence(options);
  assert.equal(result.status, 'observed-model-input');
  assert.deepEqual(result.events, [event]);
  assert.match(result.instructionSha256, /^[a-f0-9]{64}$/);
  writeEvents([{ ...event, data: { ...event.data, role: 'user' } }]);
  assert.equal(readCopilotInstructionEvidence(options).status, 'unavailable');
  assert.equal(readCopilotInstructionEvidence({ ...options, sessionId: '..' }).status, 'unavailable');
  writeFileSync(path, 'not JSON');
  assert.equal(readCopilotInstructionEvidence(options).status, 'unavailable');
});

test('managed Claude settings fail closed without exposing their values', () => {
  assert.doesNotThrow(() => assertNoManagedClaudeSettings({ effective: {} }));
  assert.throws(() => assertNoManagedClaudeSettings(undefined), /Cannot verify/);
  for (const settings of [{ env: { SECRET: 'private' } }, { policyHelper: 'command' }, { permissions: {} }]) {
    assert.throws(() => assertNoManagedClaudeSettings({ effective: settings }), (error) => {
      assert.match(error.message, /Managed Claude policy is active/);
      assert.doesNotMatch(error.message, /private|command|SECRET/);
      return true;
    });
  }
});

test('native environment excludes ambient configuration and keeps credentials off disk', () => {
  for (const client of ['claude', 'copilot']) {
    const isolated = prepareAcpEnvironment(client, {
      env: {
        Path: process.env.Path ?? process.env.PATH,
        HOME: 'ambient-home', USERPROFILE: 'ambient-home',
        COPILOT_HOME: 'ambient-copilot', CLAUDE_CONFIG_DIR: 'ambient-claude',
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'ambient-instructions',
        COPILOT_PROVIDER_BASE_URL: 'https://unwanted.invalid',
        ANTHROPIC_BASE_URL: 'https://unwanted.invalid',
        NODE_OPTIONS: '--require=unwanted', BASH_ENV: 'unwanted',
        CLAUDE_AGENT_LOGS: 'unwanted', GH_TOKEN: 'unwanted', OTHER_SECRET: 'unwanted',
        HTTPS_PROXY: 'https://proxy.example.invalid', HTTP_PROXY: 'http://proxy.example.invalid',
        NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: 'ca.pem', SSL_CERT_FILE: 'ca.pem',
      },
      credentials: client === 'claude' ? { CLAUDE_CODE_OAUTH_TOKEN: 'test-only-secret' } : { COPILOT_GITHUB_TOKEN: 'test-only-secret' },
    });
    try {
      assert.equal(isolated.env.HOME, isolated.home);
      assert.equal(isolated.env.USERPROFILE, isolated.home);
      assert.equal(isolated.env.COPILOT_HOME, join(isolated.home, '.copilot'));
      assert.equal(isolated.env.CLAUDE_CONFIG_DIR, join(isolated.home, '.claude'));
      for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
        assert.ok(isolated.env[key], key);
      }
      for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'ANTHROPIC_BASE_URL', 'COPILOT_PROVIDER_BASE_URL',
        'CLAUDE_AGENT_LOGS', 'GH_TOKEN', 'OTHER_SECRET', 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS']) {
        assert.equal(isolated.env[key], undefined, key);
      }
      const settings = JSON.parse(readFileSync(join(isolated.home, '.claude', 'settings.json')));
      assert.equal(settings.permissions.defaultMode, 'dontAsk');
      assert.equal(settings.disableAllHooks, true);
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else assert.doesNotMatch(readFileSync(path, 'utf8'), /test-only-secret|unwanted/);
        }
      };
      visit(isolated.home);
    } finally { isolated.cleanup(); }
    assert.equal(existsSync(isolated.home), false);
  }
});

test('credential resolution is explicit, never logs or starts a login, and rejects expired Claude auth', () => {
  const forbidden = () => { throw new Error('must not run'); };
  assert.deepEqual(resolveAcpCredentials('claude', {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }, read: forbidden, exec: forbidden,
  }), { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
  assert.deepEqual(resolveAcpCredentials('claude', {
    env: {}, now: 10,
    read: () => JSON.stringify({ claudeAiOauth: { accessToken: 'existing', expiresAt: 11 } }),
  }), { CLAUDE_CODE_OAUTH_TOKEN: 'existing' });
  for (const oauth of [{}, { accessToken: 'expired', expiresAt: 10 }, { accessToken: 'undated' }]) {
    assert.throws(() => resolveAcpCredentials('claude', {
      env: {}, now: 10, read: () => JSON.stringify({ claudeAiOauth: oauth }),
    }), /missing or expired/);
  }
  assert.throws(() => resolveAcpCredentials('claude', { env: {}, read: forbidden }), /no login was attempted/);
  assert.deepEqual(resolveAcpCredentials('copilot', {
    env: { GH_TOKEN: 'configured' }, exec: forbidden,
  }), { COPILOT_GITHUB_TOKEN: 'configured' });
  assert.deepEqual(resolveAcpCredentials('copilot', {
    env: {}, exec: (command, args, options) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['auth', 'token']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return 'existing\n';
    },
  }), { COPILOT_GITHUB_TOKEN: 'existing' });
  assert.throws(() => resolveAcpCredentials('copilot', { env: {}, exec: forbidden }), /no login was attempted/);
});

test('native preflight rejects unavailable credentials after checking the pinned runtime', () => {
  for (const [client, version] of [['claude', '0.94.0'], ['copilot', '1.0.102']]) {
    const launch = { isolatedClient: client, command: 'synthetic-runtime', args: [], expectedAgentVersion: version };
    const checked = [];
    const exec = () => { checked.push('runtime'); return version; };
    assert.throws(() => checkAcpRuntime(launch, {
      exec,
      resolveCredentials(selected) {
        assert.equal(selected, client);
        checked.push('credential');
        throw new Error('existing credential expired; no refresh attempted');
      },
    }), /existing credential expired/);
    assert.deepEqual(checked, ['runtime', 'credential']);
    const result = checkAcpRuntime(launch, { exec, resolveCredentials: () => ({}) });
    assert.match(result.authentication, /existing credential available/);
    assert.match(result.authentication, /provider access not checked/);
  }
});
