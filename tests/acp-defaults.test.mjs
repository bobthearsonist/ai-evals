import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClaudeRunner } from '../local/claude-plugin-eval.mjs';
import { createCopilotRunner } from '../local/copilot.mjs';
import { gradeTranscript } from '../local/grade.mjs';
import { diffRuns, historyRoot } from '../local/summary.mjs';
import { regradeRun } from '../local/regrade.mjs';
import { parseAcpTrace } from '../local/acp-runner.mjs';

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

test('both public adapter factories default to ACP and refuse unverified native isolation without spawning', async () => {
  for (const create of [createClaudeRunner, createCopilotRunner]) {
    const runner = create({ exe: 'must-not-be-launched' });
    assert.equal(runner.transport, 'acp');
    assert.equal(runner.capabilities.skillTrace, false);
    const preflight = await runner.preflight({ model: 'synthetic-model' });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.transport, 'acp');
    assert.match(preflight.problems.join(';'), /no verified ambient skills\/MCP isolation/);
    assert.doesNotMatch(preflight.problems.join(';'), /ENOENT|not runnable/);
  }
});

test('default CLI preflight reports ACP refusals for both clients and requires an explicit model', () => {
  for (const client of ['claude', 'copilot']) {
    const result = invoke(['preflight', '--client', client, '--model', 'synthetic-model', '--exe', 'must-not-launch']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).transport, 'acp');
    assert.match(result.stdout, /no verified ambient skills/);
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
      '--approve-sessions', '1', '--output-dir', output]);
    assert.equal(result.status, 0, result.stderr);
    const normalized = JSON.parse(result.stdout);
    assert.equal(normalized.transport, 'acp');
    assert.equal(normalized.sessions, 1);
    assert.equal(normalized.client, client);
    assert.equal(normalized.costUsd, null);
    assert.match(normalized.caveats.join(';'), /custom ACP profile.*not verified/);
    const runDir = join(output, readdirSync(output)[0]);
    const captured = JSON.parse(readFileSync(join(runDir, 'traces', 'negative-control', 'with-1.jsonl')));
    assert.equal(captured.type, 'ai-evals.acp');
    assert.equal(Array.isArray(captured.transcript.raw), true);
    assert.equal(captured.transcript.finalText, 'hello world');
    assert.equal(captured.transcript.model, 'synthetic-model');
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
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /client=claude transport=acp model=synthetic-model/);
  assert.match(result.stdout, /client=copilot transport=acp model=selected-model/);
  const summary = readFileSync(join(root, 'results', 'smoke-summary.md'), 'utf8');
  assert.match(summary, /\| claude \| acp \|/);
  assert.match(summary, /\| copilot \| acp \|/);
});

test('default spend-cap and legacy-only options cannot imply unsupported ACP guarantees', () => {
  for (const option of ['--max-cost-usd', '--max-ai-credits']) {
    const result = invoke(['preflight', option, '1']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ACP profiles do not enforce spend caps/);
  }
  const legacy = invoke(['preflight', '--transport', 'native', '--exe', 'must-not-launch']);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stdout, /not runnable/);
  assert.doesNotMatch(legacy.stdout, /ambient skills/);
});

test('default dry-run plans remain offline and retain the existing approval gate contract', () => {
  const result = invoke(['run', '--config', config, '--suite', 'demo', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.transport, 'acp');
  assert.equal(plan.plannedSessions, 18);
  const unapproved = invoke(['run', '--config', config, '--suite', 'demo']);
  assert.equal(unapproved.status, 4);
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
  const runner = createClaudeRunner({ acpProfile: {
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

test('ACP and legacy native histories never compare or overwrite one another', () => {
  const identity = { client: 'claude', model: 'selected-model' };
  assert.notEqual(historyRoot('results', identity), historyRoot('results', { ...identity, transport: 'acp' }));
  assert.deepEqual(diffRuns({ ...identity, cases: [] }, { ...identity, transport: 'acp', cases: [{ id: 'new' }] }), []);
});
