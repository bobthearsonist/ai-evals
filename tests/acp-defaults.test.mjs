import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gradeTranscript } from '../local/grade.mjs';
import { diffRuns, historyRoot } from '../local/summary.mjs';
import { regradeRun } from '../local/regrade.mjs';
import { createAcpRunner, parseAcpTrace } from '../local/acp-runner.mjs';

const cli = resolve(import.meta.dirname, '..', 'local', 'cli.mjs');
const fake = resolve(import.meta.dirname, 'fixtures', 'fake-acp.mjs');
const config = resolve(import.meta.dirname, 'fixtures', 'evals.json');
const work = resolve(import.meta.dirname, '..', '.work');
const invoke = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function setup(t) {
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(join(work, 'acp-defaults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ command: process.execPath, args: [fake], env: { FAKE_ACP_MODE: 'normal' } }));
  return { root, profile };
}

test('both clients use ACP and reject unavailable or unsupported executable overrides', async () => {
  for (const client of ['claude', 'copilot']) {
    const runner = createAcpRunner({ client, exe: 'must-not-be-launched' });
    assert.equal(runner.transport, 'acp');
    assert.equal(runner.capabilities.skillTrace, false);
    const preflight = await runner.preflight({ model: 'synthetic-model' });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.transport, 'acp');
    assert.match(preflight.problems.join(';'), /command overrides are not supported|not runnable/);
  }
});

test('default CLI preflight reports executable errors for both clients and requires an explicit model', () => {
  for (const client of ['claude', 'copilot']) {
    const result = invoke(['preflight', '--client', client, '--model', 'synthetic-model', '--exe', 'must-not-launch']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).transport, 'acp');
    assert.match(result.stdout, /command overrides are not supported|not runnable/);
    const missing = invoke(['preflight', '--client', client]);
    assert.match(missing.stdout, /explicit model/);
  }
});

test('default CLI executions use real fake ACP subprocesses, archive protocol events and replay with no source or profile', (t) => {
  const { root, profile } = setup(t);
  for (const client of ['claude', 'copilot']) {
    const output = join(root, client);
    const result = invoke(['smoke', '--client', client, '--config', config, '--suite', 'demo',
      '--case', 'negative-control', '--model', 'synthetic-model', '--acp-profile', profile,
      '--approve-sessions', '1', '--output-dir', output, '--json']);
    assert.equal(result.status, 1, result.stderr);
    const normalized = JSON.parse(result.stdout);
    assert.equal(normalized.status, 'below_threshold');
    assert.equal(normalized.cases[0].invalidRuns, 0);
    assert.equal(normalized.transport, 'acp');
    assert.equal(normalized.sessions, 1);
    assert.equal(normalized.client, client);
    assert.equal(normalized.costUsd, 0.002);
    assert.match(normalized.caveats.join(';'), /custom ACP profile.*not verified/);
    const runDir = join(output, readdirSync(output)[0]);
    const captured = JSON.parse(readFileSync(join(runDir, 'traces', 'negative-control', 'with-1.jsonl')));
    assert.equal(captured.type, 'ai-evals.acp');
    assert.equal(Array.isArray(captured.transcript.raw), true);
    assert.equal(captured.transcript.finalText, 'hello world');
    assert.equal(captured.transcript.model, 'synthetic-model');
    const receipt = JSON.parse(readFileSync(join(runDir, 'traces', 'negative-control', 'with-1.jsonl.receipt.json')));
    assert.equal(receipt.valid, true);
    assert.deepEqual(receipt.grade.checks.filter((check) => check.passed === false), [{ name: 'farewell', passed: false }]);
    const replay = invoke(['regrade', runDir]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /policy=recorded/);
    assert.match(replay.stdout, new RegExp(`with=${normalized.cases[0].withScore.toFixed(2)}`));
  }
});

test('run-all forwards per-client custom ACP profiles and models without an explicit transport flag', (t) => {
  const { root, profile } = setup(t);
  const result = invoke(['smoke', '--runners', 'claude,copilot', '--config', config, '--suite', 'demo',
    '--case', 'negative-control', '--claude-model', 'synthetic-model', '--copilot-model', 'selected-model',
    '--claude-acp-profile', profile, '--copilot-acp-profile', profile, '--approve-sessions', '2',
    '--output-dir', join(root, 'runs'), '--results-dir', join(root, 'results')]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /: error/);
  assert.equal((result.stdout.match(/demo: below_threshold/g) ?? []).length, 2);
  assert.match(result.stdout, /client=claude transport=acp model=synthetic-model/);
  assert.match(result.stdout, /client=copilot transport=acp model=selected-model/);
  const summary = readFileSync(join(root, 'results', 'smoke-summary.md'), 'utf8');
  assert.match(summary, /\| claude \| acp \|/);
  assert.match(summary, /\| copilot \| acp \|/);
});

test('passing smoke and paired runs exit zero for single and multiple runners', (t) => {
  const { root, profile } = setup(t);
  const suiteDir = join(root, 'cases', 'passing');
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(suiteDir, 'greeting.json'), JSON.stringify({
    schemaVersion: 2, id: 'greeting', prompt: 'Say hello.', shouldTrigger: false,
    checks: [{ name: 'greeting', type: 'contains', value: 'hello world' }],
  }));
  const passingConfig = join(root, 'evals.json');
  writeFileSync(passingConfig, JSON.stringify({
    casesDir: 'cases', skillsRoots: [resolve(import.meta.dirname, 'fixtures', 'skills')],
    suites: { passing: { skill: 'demo' } },
  }));

  for (const command of ['smoke', 'run']) for (const multiple of [false, true]) {
    const planned = (command === 'smoke' ? 1 : 2) * (multiple ? 2 : 1);
    const selection = multiple
      ? ['--runners', 'claude,copilot', '--claude-model', 'synthetic-model', '--copilot-model', 'selected-model',
        '--claude-acp-profile', profile, '--copilot-acp-profile', profile]
      : ['--client', 'claude', '--model', 'synthetic-model', '--acp-profile', profile];
    const entrypoint = command === 'run' && multiple ? 'run-all' : command;
    const output = join(root, command, multiple ? 'multiple' : 'single');
    const result = invoke([entrypoint, '--config', passingConfig, '--suite', 'passing', ...selection,
      '--runs', '1', '--approve-sessions', String(planned), '--json',
      '--output-dir', output, '--results-dir', join(output, 'results')]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    const results = multiple ? parsed.results : [parsed];
    assert.equal(results.length, multiple ? 2 : 1);
    assert.equal(results.reduce((sum, item) => sum + item.sessions, 0), planned);
    for (const item of results) {
      assert.equal(item.status, 'passed');
      assert.equal(item.overallScore, 1);
      assert.equal(item.cases[0].invalidRuns, 0);
      assert.equal(item.error, undefined);
    }
  }
});

test('default spend-cap and legacy-only options cannot imply unsupported ACP guarantees', () => {
  for (const command of [['preflight'], ['preflight', '--runners', 'claude,copilot']]) {
    for (const option of ['--max-cost-usd', '--max-ai-credits', '--copilot-home', '--transport']) {
      const result = invoke([...command, option, '1']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown option/);
    }
  }
  const legacy = invoke(['preflight', '--transport', 'native', '--exe', 'must-not-launch']);
  assert.equal(legacy.status, 2);
  assert.match(legacy.stderr, /Unknown option '--transport'/);
});

test('native archives are explicitly refused for both replay and judging', (t) => {
  const { root } = setup(t);
  mkdirSync(join(root, 'traces'));
  const rubric = join(root, 'rubric.txt');
  writeFileSync(rubric, 'Say hello.');
  for (const transport of [undefined, 'native']) {
    writeFileSync(join(root, 'normalized.json'), JSON.stringify({ client: 'claude', transport }));
    for (const args of [['regrade', root], ['judge', root, '--client', 'claude',
      '--model', 'synthetic-model', '--rubric', rubric, '--dry-run']]) {
      const result = invoke(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /only ACP archives are supported/);
    }
  }
});

test('default dry-run plans remain offline and approval errors use the documented exit code', () => {
  const result = invoke(['run', '--config', config, '--suite', 'demo', '--dry-run', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.transport, 'acp');
  assert.equal(plan.plannedSessions, 18);
  const unapproved = invoke(['run', '--config', config, '--suite', 'demo']);
  assert.equal(unapproved.status, 2);
  assert.match(unapproved.stderr, /--approve-sessions 18/);
});

test('default factory captures a refused fixture fake subprocess as invalid and replays it identically', async (t) => {
  const { root } = setup(t);
  const source = join(root, 'source');
  const fixtures = join(root, 'fixtures');
  mkdirSync(source);
  mkdirSync(fixtures);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nSay hello.\n');
  writeFileSync(join(fixtures, 'input.txt'), 'fixture text');
  const c = { schemaVersion: 2, id: 'fixture', prompt: 'Read {{fixtures}}', fixtures: true, shouldTrigger: false,
    checks: [{ name: 'greeting', type: 'contains', value: 'hello' }] };
  const runner = createAcpRunner({ client: 'claude', acpProfile: {
    command: process.execPath, args: [fake], env: { FAKE_ACP_MODE: 'blocked-inputs' },
  } });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, fixturesDir: fixtures, cases: [c] });
  const result = await runner.run([c], { ...prepared, model: 'synthetic-model', runs: 1, ablation: 'none', outputDir: join(root, 'output') });
  assert.equal(result.status, 'partial');
  assert.equal(result.cases[0].invalidRuns, 1);
  assert.equal(result.cases[0].withScore, null);
  assert.match(result.caveats.join(';'), /fixture file reads were refused/);
  const replay = regradeRun({ cases: [c], tracesDir: join(root, 'traces'), parse: parseAcpTrace, requireReceipt: true });
  assert.equal(replay[0].invalidRuns, 1);
  assert.equal(replay[0].withScore, null);
});

test('fixture refusals are invalid ACP evidence; unread, recovered and nonfixture answers remain scored', () => {
  const c = { schemaVersion: 2, id: 'fixture', fixtures: true, shouldTrigger: false,
    checks: [{ name: 'hello', type: 'contains', value: 'hello' }] };
  const denied = { name: 'Read', status: 'failed', rawOutput: 'Permission to use Read has been denied' };
  const success = { name: 'Read', status: 'completed', rawOutput: 'fixture contents' };
  const transcript = { transport: 'acp', finalText: 'hello', toolCalls: [denied], raw: 'events' };
  assert.equal(gradeTranscript(c, transcript).invalid, true);
  for (const toolCalls of [[], [denied, success]]) {
    assert.equal(gradeTranscript(c, { ...transcript, toolCalls }).invalid, false);
  }
  assert.equal(gradeTranscript({ ...c, fixtures: false }, transcript).invalid, false);
});

test('non-ACP histories are neither accepted nor compared', () => {
  const identity = { client: 'claude', model: 'selected-model' };
  assert.throws(() => historyRoot('results', { ...identity, transport: 'native' }), /only ACP history/);
  assert.deepEqual(diffRuns({ ...identity, cases: [] }, { ...identity, transport: 'acp', cases: [{ id: 'new' }] }), []);
});
