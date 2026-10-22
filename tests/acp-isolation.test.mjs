import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoManagedClaudeSettings, prepareAcpEnvironment, resolveAcpCredentials } from '../local/acp-isolation.mjs';

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
      },
      credentials: client === 'claude' ? { CLAUDE_CODE_OAUTH_TOKEN: 'test-only-secret' } : { COPILOT_GITHUB_TOKEN: 'test-only-secret' },
    });
    try {
      assert.equal(isolated.env.HOME, isolated.home);
      assert.equal(isolated.env.USERPROFILE, isolated.home);
      assert.equal(isolated.env.COPILOT_HOME, join(isolated.home, '.copilot'));
      assert.equal(isolated.env.CLAUDE_CONFIG_DIR, join(isolated.home, '.claude'));
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
