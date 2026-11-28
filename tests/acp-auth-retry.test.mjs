import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcpRunner, parseAcpTrace } from '../local/acp-runner.mjs';
import { executeAcp } from '../local/acp.mjs';
import { compileFeature } from '../local/suite.mjs';
import { regradeRun } from '../local/regrade.mjs';

const feature = `Feature: Credential rotation
  @case:greeting @should-not-trigger
  Scenario: Respond
    When the user asks:
      """
      Say hello.
      """
    Then the response contains "hello"
`;

// Synthetic placeholders: these tests never read a real credential. Assertions
// compare labels, so a failure can never print whatever the child received.
const REVOKED = 'synthetic-revoked-token';
const CURRENT = 'synthetic-current-token';
const label = (token) => ({ [REVOKED]: 'revoked', [CURRENT]: 'current' })[token] ?? 'unexpected credential';

// What executeAcp captures when the Claude adapter rejects a revoked OAuth token.
const rejection = () => ({
  finalText: 'Failed to authenticate: OAuth token revoked.', toolCalls: [], complete: false,
  usage: null, model: 'haiku', stopReason: null,
  raw: [
    { direction: 'out', method: 'session/prompt', params: { sessionId: 'fake-session', prompt: [] } },
    { direction: 'error', phase: 'protocol', message: 'Authentication required', code: -32000 },
  ],
  errors: ['ACP client claude (profile claude): Authentication required'],
});
const answer = () => ({ finalText: 'hello', toolCalls: [], raw: [], complete: true, usage: null, model: 'haiku', stopReason: 'end_turn', errors: [] });

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-auth-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'skill');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
  return { root, source, cases: compileFeature(feature, { uri: 'rotation.feature' }) };
}

// The real native Claude launch, executeAcp and isolated environment; only the
// runtime probe, the credential source and the agent process are replaced.
const nativeRunner = ({ resolveCredentials, agent }) => createAcpRunner({
  client: 'claude',
  checkRuntime: () => ({ authentication: 'not checked; offline test' }),
  execute: (options) => executeAcp(options, { resolveCredentials, executeConfigured: agent }),
});

const run = (runner, { root, source, cases }, schedule) => {
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  return runner.run(cases, { ...prepared, outputDir: join(root, 'eval-output'), model: 'haiku', ...schedule })
    .then((result) => ({ result, prepared }));
};
const readArchive = (root, name) => ({
  trace: JSON.parse(readFileSync(join(root, 'traces', 'greeting', `${name}.jsonl`), 'utf8')),
  receipt: JSON.parse(readFileSync(join(root, 'traces', 'greeting', `${name}.jsonl.receipt.json`), 'utf8')),
});

test('sessions in flight when the credential is revoked start once more with its replacement', async (t) => {
  const fixture = setup(t);
  const resolved = [];
  const used = [];
  const runner = nativeRunner({
    // The first four sessions read the token that is then revoked; later reads get its replacement.
    resolveCredentials: (client) => {
      assert.equal(client, 'claude');
      resolved.push(resolved.length < 4 ? REVOKED : CURRENT);
      return { CLAUDE_CODE_OAUTH_TOKEN: resolved.at(-1) };
    },
    agent: async (launch, environment) => {
      used.push(label(environment.CLAUDE_CODE_OAUTH_TOKEN));
      await delay(10);
      return environment.CLAUDE_CODE_OAUTH_TOKEN === REVOKED ? rejection() : answer();
    },
  });
  const { result, prepared } = await run(runner, fixture, { runs: 2, ablation: 'with-without', concurrency: 4 });
  assert.equal(result.status, 'passed', JSON.stringify(result.caveats));
  assert.equal(result.sessions, 4, 'a retry is not a new scheduled session');
  assert.equal(resolved.length, 8, 'every start resolves the credential again');
  assert.deepEqual(used, ['revoked', 'revoked', 'revoked', 'revoked', 'current', 'current', 'current', 'current']);
  assert.match(result.caveats.at(-1), /^4 session\(s\) started once more after the agent reported an authentication failure/);
  for (const name of ['with-1', 'without-1', 'with-2', 'without-2']) {
    const { trace, receipt } = readArchive(fixture.root, name);
    assert.equal(receipt.valid, true);
    assert.match(receipt.authRetry.error, /Authentication required/);
    assert.equal(trace.transcript.finalText, 'hello');
    assert.equal(trace.authRetry.transcript.finalText, 'Failed to authenticate: OAuth token revoked.');
  }
  const replay = regradeRun({
    cases: fixture.cases, tracesDir: join(fixture.root, 'traces'), parse: parseAcpTrace,
    canaryToken: prepared.canaryToken, requireReceipt: true,
  });
  assert.deepEqual([replay[0].withRuns, replay[0].withoutRuns, replay[0].invalidRuns], [[1, 1], [1, 1], 0]);
  for (const entry of readdirSync(fixture.root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    assert.equal(readFileSync(file, 'utf8').includes('synthetic-'), false, `${file} must not hold a credential`);
  }
});

test('a session rejected again after its retry is not started a third time and stops the run', async (t) => {
  const fixture = setup(t);
  let resolutions = 0;
  let starts = 0;
  const runner = nativeRunner({
    resolveCredentials: () => { resolutions++; return { CLAUDE_CODE_OAUTH_TOKEN: REVOKED }; },
    agent: async () => { starts++; return rejection(); },
  });
  const { result } = await run(runner, fixture, { runs: 2, ablation: 'with-without', concurrency: 1 });
  assert.equal(starts, 2);
  assert.equal(resolutions, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.sessions, 1);
  assert.match(result.caveats.at(-1), /Authentication required/);
  assert.match(result.caveats.at(-2), /^1 session\(s\) started once more/);
  const { trace, receipt } = readArchive(fixture.root, 'with-1');
  assert.equal(receipt.valid, false);
  assert.match(receipt.error, /Authentication required/);
  assert.match(receipt.authRetry.error, /Authentication required/);
  assert.equal(trace.transcript.complete, false);
  assert.equal(trace.authRetry.transcript.complete, false);
});

test('the rejected attempt stays archived when the credential cannot be resolved again', async (t) => {
  const fixture = setup(t);
  let resolutions = 0;
  const runner = nativeRunner({
    resolveCredentials: () => {
      if (++resolutions > 1) throw new Error('Existing Claude OAuth credential is missing or expired; refresh it in the native client before retrying');
      return { CLAUDE_CODE_OAUTH_TOKEN: REVOKED };
    },
    agent: async () => rejection(),
  });
  const { result } = await run(runner, fixture, { runs: 1, ablation: 'none', concurrency: 1 });
  assert.equal(result.status, 'partial');
  assert.equal(resolutions, 2);
  const { trace, receipt } = readArchive(fixture.root, 'with-1');
  assert.match(receipt.error, /missing or expired/);
  assert.match(receipt.authRetry.error, /Authentication required/);
  assert.deepEqual(trace.transcript.errors, [receipt.error]);
  assert.equal(trace.authRetry.transcript.finalText, 'Failed to authenticate: OAuth token revoked.');
});

test('protocol failures other than authentication are never retried', async (t) => {
  const fixture = setup(t);
  let starts = 0;
  const runner = nativeRunner({
    resolveCredentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: CURRENT }),
    agent: async () => {
      starts++;
      return { ...rejection(), raw: [{ direction: 'error', phase: 'protocol', message: 'Internal error', code: -32603 }], errors: ['Internal error'] };
    },
  });
  const { result } = await run(runner, fixture, { runs: 1, ablation: 'with-without', concurrency: 2 });
  assert.equal(starts, 2, 'each scheduled session started exactly once');
  assert.equal(result.status, 'partial');
  assert.equal(result.caveats.some((caveat) => /started once more/.test(caveat)), false);
  assert.equal(readArchive(fixture.root, 'with-1').receipt.authRetry, undefined);
});
