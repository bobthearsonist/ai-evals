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

for (const client of ['claude', 'copilot']) test(`${client} stages paired Gherkin skills and readable fixtures with identical replay policy`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-runner-'));
  try {
    const source = join(root, 'skill');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
    const fixturesDir = join(root, 'inputs');
    mkdirSync(fixturesDir);
    writeFileSync(join(fixturesDir, 'input.txt'), 'synthetic fixture');
    const cases = compileFeature(feature
      .replace('    When the user asks:', '    Given the suite fixtures are available\n    When the user asks:')
      .replace('Say hello.', 'Say hello. Read {{fixtures}}.'), { uri: 'transport.feature' });
    const workspaces = [];
    let calls = 0;
    const launches = new WeakSet();
    const runner = createAcpRunner({
      client,
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
        assert.equal(prompt, `Say hello. Read ${join(cwd, 'fixtures')}.`);
        assert.equal(readFileSync(join(cwd, 'fixtures', 'input.txt'), 'utf8'), 'synthetic fixture');
        assert.equal(existsSync(join(cwd, client === 'claude' ? '.claude' : '.github', 'skills', 'demo')), calls === 1);
        assert.equal(options.skillName, calls === 1 ? 'demo' : undefined);
        return { finalText: 'hello', toolCalls: [], raw: 'hello', complete: true, usage: null, errors: [] };
      },
    });
    const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, fixturesDir, cases });
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

test('Copilot native skill events and anonymous ACP reads grade identically live and replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-copilot-tools-'));
  try {
    const source = join(root, 'skill');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
    const cases = compileFeature(feature.replace('@should-not-trigger', '@should-trigger'), { uri: 'copilot-tools.feature' });
    const transcript = {
      finalText: 'hello', complete: true, errors: [], raw: [],
      toolCalls: [
        { title: 'Using skill: demo', kind: 'other', rawInput: { skill: 'demo' }, status: 'completed' },
        { title: 'Viewing input.txt', kind: 'read', rawInput: { path: 'input.txt' }, status: 'completed' },
        { title: 'Searching files', kind: 'search', rawInput: { pattern: '*.md' }, status: 'completed' },
      ],
    };
    const runner = createAcpRunner({
      client: 'copilot', launch: (options) => Object.freeze({ ...options }), execute: async () => transcript,
    });
    const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
    const result = await runner.run(cases, {
      ...prepared, outputDir: join(root, 'eval-output'), runs: 1, ablation: 'none', model: 'fake-model',
    });
    assert.equal(result.status, 'passed', JSON.stringify(result.caveats));
    assert.equal(result.cases[0].withScore, 1);
    assert.equal(transcript.toolCalls[0].name, undefined, 'do not mutate the native evidence');
    const replay = regradeRun({
      cases, tracesDir: join(root, 'traces'), parse: parseAcpTrace,
      canaryToken: prepared.canaryToken, requireReceipt: true,
    });
    assert.equal(replay[0].withScore, 1);
    assert.equal(replay[0].invalidRuns, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('anonymous ACP reads preserve fixture-denial checks and do not imply native tool names', () => {
  const c = {
    schemaVersion: 2, id: 'native-read', prompt: 'Read fixture.', fixtures: true, shouldTrigger: false,
    checks: [{ name: 'answer', type: 'contains', value: 'hello' }],
  };
  const parse = (toolCalls) => parseAcpTrace(JSON.stringify({
    type: 'ai-evals.acp', schemaVersion: 1,
    transcript: { finalText: 'hello', complete: true, raw: [], toolCalls },
  }));
  const read = { kind: 'read', rawInput: { path: 'input.txt' }, status: 'completed' };
  const allowed = parse([read]);
  assert.equal(gradeTranscript(c, allowed, { arm: 'without' }).score, 1);
  assert.equal(allowed.toolCalls[0].name, undefined);
  const denied = gradeTranscript(c, parse([{ ...read, status: 'failed', rawOutput: 'Permission denied' }]), { arm: 'without' });
  assert.equal(denied.invalid, true);
  assert.match(denied.errors[0].diagnostic, /reads were refused/);
  const order = gradeTranscript({
    ...c, checks: [{ name: 'order', type: 'tool_order', before: 'Skill', after: 'view' }],
  }, allowed, { arm: 'without' });
  assert.equal(order.invalid, true, 'a category is not a fabricated native tool name');
});

test('unrecognized anonymous tools cannot be mistaken for skill evidence', () => {
  for (const call of [
    { kind: 'other', title: 'Using skill: demo' },
    { kind: 'other', title: 'Using skill: demo', rawInput: { skill: 'different' } },
    { kind: 'other', title: 'Some other tool', rawInput: { skill: 'demo' } },
    { kind: 'other', title: 'Using skill: ', rawInput: { skill: '' } },
  ]) {
    const parsed = parseAcpTrace(JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: 'hello', complete: true, raw: [], toolCalls: [call] },
    }));
    const grade = gradeTranscript({
      schemaVersion: 2, id: 'skill', prompt: 'Invoke demo.', shouldTrigger: true,
      checks: [{ name: 'answer', type: 'contains', value: 'hello' }],
    }, parsed, { arm: 'with' });
    assert.equal(grade.invalid, true);
    assert.match(grade.errors[0].diagnostic, /tool-call evidence is missing/);
  }
});
