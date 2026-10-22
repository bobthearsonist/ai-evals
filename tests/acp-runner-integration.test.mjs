import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAcpRunner, parseAcpTrace } from '../local/acp-runner.mjs';
import { buildAcpLaunch } from '../local/acp.mjs';
import { compileFeature } from '../local/suite.mjs';
import { regradeRun } from '../local/regrade.mjs';
import { gradeTranscript } from '../local/grade.mjs';

const feature = `Feature: Shared transport
  @case:greeting @should-not-trigger
  Scenario: Respond
    When the user asks:
      """
      Say hello.
      """
    Then the response contains "hello"
`;

test('Gherkin cases execute through the ACP runner and replay the identical host policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-runner-'));
  try {
    const source = join(root, 'skill');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
    const cases = compileFeature(feature, { uri: 'transport.feature' });
    const workspaces = [];
    let calls = 0;
    const launches = new WeakSet();
    const runner = createAcpRunner({
      client: 'copilot',
      launch: (options) => {
        const result = Object.freeze({ ...options });
        launches.add(result);
        return result;
      },
      execute: async (options) => {
        assert.equal(launches.has(options), true, 'preserve the builder object identity');
        const { cwd, prompt } = options;
        calls++;
        workspaces.push(cwd);
        assert.equal(prompt, 'Say hello.');
        assert.equal(existsSync(join(cwd, '.github', 'skills', 'demo')), calls === 1);
        return { finalText: 'hello', toolCalls: [], raw: 'hello', complete: true, usage: null, errors: [] };
      },
    });
    const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
    const result = await runner.run(cases, {
      ...prepared, outputDir: join(root, 'eval-output'), runs: 1, ablation: 'with-without', model: 'fake-model',
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'passed');
    assert.equal(result.cases[0].withScore, 1);
    assert.equal(result.cases[0].withoutScore, 1);
    for (const workspace of workspaces) assert.equal(existsSync(workspace), false);
    const replay = regradeRun({
      cases, tracesDir: join(root, 'traces'), parse: parseAcpTrace,
      canaryToken: prepared.canaryToken, requireReceipt: true,
    });
    assert.equal(replay[0].withScore, result.cases[0].withScore);
    assert.equal(replay[0].withoutScore, result.cases[0].withoutScore);
    const receipt = JSON.parse(readFileSync(join(root, 'traces', 'greeting', 'with-1.jsonl.receipt.json')));
    assert.equal(receipt.usage, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACP runner archives failed evidence, excludes it, and never retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-failure-'));
  try {
    const source = join(root, 'skill');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
    const cases = compileFeature(feature, { uri: 'transport.feature' });
    let calls = 0;
    const runner = createAcpRunner({
      client: 'copilot', launch: () => ({}),
      execute: async () => { calls++; throw new Error('fake transport failure'); },
    });
    const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
    const result = await runner.run(cases, {
      ...prepared, outputDir: join(root, 'eval-output'), runs: 3, ablation: 'with-without', model: 'fake-model',
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.cases[0].withScore, null);
    assert.equal(result.cases[0].invalidRuns, 1);
    const replay = regradeRun({ cases, tracesDir: join(root, 'traces'), parse: parseAcpTrace, requireReceipt: true });
    assert.equal(replay[0].invalidRuns, 1);
    assert.equal(replay[0].withScore, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACP runner executes a branded launch through the actual SDK fake subprocess', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-sdk-runner-'));
  try {
    const source = join(root, 'skill');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
    const cases = compileFeature(feature, { uri: 'transport.feature' });
    const runner = createAcpRunner({
      client: 'copilot',
      launch: (options) => buildAcpLaunch({
        ...options, client: 'custom', profile: 'custom', command: process.execPath,
        args: [resolve(import.meta.dirname, 'fixtures/fake-acp.mjs')], env: { FAKE_ACP_MODE: 'normal' },
      }),
    });
    const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
    const result = await runner.run(cases, {
      ...prepared, outputDir: join(root, 'eval-output'), runs: 1, ablation: 'with-without',
      model: 'synthetic-model', timeoutSeconds: 5,
    });
    assert.equal(result.status, 'passed', JSON.stringify(result.caveats));
    const path = join(root, 'traces', 'greeting', 'with-1.jsonl');
    const archived = readFileSync(path, 'utf8');
    assert.equal(Array.isArray(JSON.parse(archived).transcript.raw), true, 'preserve original protocol events');
    const parsed = parseAcpTrace(archived);
    assert.equal(typeof parsed.raw, 'string', 'adapt protocol events to the shared trace contract');
    assert.equal(parsed.finalText, 'hello world');
    assert.equal(parsed.toolCalls[0].name, 'Read');
    const replay = regradeRun({
      cases, tracesDir: join(root, 'traces'), parse: parseAcpTrace, requireReceipt: true, canaryToken: prepared.canaryToken,
    });
    assert.equal(replay[0].withScore, result.cases[0].withScore);
    assert.equal(replay[0].withoutScore, result.cases[0].withoutScore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACP replay checks canaries and trace assertions inside structured raw events', () => {
  const parsed = parseAcpTrace(JSON.stringify({
    type: 'ai-evals.acp', schemaVersion: 1, transcript: {
      finalText: 'hello', toolCalls: [], complete: true,
      raw: [{ direction: 'incoming', text: 'prefix-canary-secret-suffix' }],
    },
  }));
  const grade = gradeTranscript({
    schemaVersion: 2, id: 'raw-events', prompt: 'Say hello.', shouldTrigger: false,
    checks: [{ name: 'protocol-content', type: 'contains', target: 'trace', value: 'prefix-canary-secret-suffix' }],
  }, parsed, { arm: 'with', canaryToken: 'canary-secret' });
  assert.equal(grade.checks.find((check) => check.name === 'protocol-content').passed, true);
  assert.equal(grade.checks.find((check) => check.name === 'canary').passed, false);
});
