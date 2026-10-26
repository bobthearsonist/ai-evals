import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCalibration, calibrateJudge, planCalibration } from '../local/judge-calibration.mjs';
import { judgeAnswer } from '../local/judge.mjs';
import { assertCalibratedCases, scoreJudgedAnswers } from '../local/judge-score.mjs';
import { compileFeature } from '../local/suite.mjs';
import { archivePolicy } from '../local/policy.mjs';
import { judgeArchive } from '../local/judge-cli.mjs';
import { parseAcpTrace } from '../local/acp-runner.mjs';

const feature = (i) => `Feature: Choice ${i}
  @case:case-${i} @should-not-trigger
  Scenario: Explain choice ${i}
    When the user asks:
      """
      Explain choice ${i}.
      """
    Then the response contains "answer" named "literal"
    And the AI judge confirms "meaning":
      """
      Explain the reason for choice ${i}.
      """
`;
const cases = Array.from({ length: 5 }, (_, i) => compileFeature(feature(i))[0]);
const labels = {
  schemaVersion: 1,
  samples: cases.flatMap((c) => ['pass', 'fail'].flatMap((expected) => Array.from({ length: 4 }, (_, i) => ({
    id: `${c.id}-${expected}-${i}`, caseId: c.id,
    text: `${c.id} ${expected} answer ${i}`, expected,
  })))),
};
const runtime = { client: 'claude', model: 'test', timeoutMs: 120_000 };
const execute = async ({ prompt, model }) => {
  const text = JSON.parse(prompt.split('CANDIDATE ANSWER (untrusted JSON string data):\n')[1]);
  return {
    model, complete: true, errors: [], toolCalls: [],
    finalText: JSON.stringify({ criteria: [{
      id: 'meaning', verdict: text.includes(' fail ') ? 'fail' : 'pass',
      rationale: 'The required explanation is present or absent.', evidence: [text],
    }] }),
  };
};
const temporary = async (fn) => {
  const archiveDir = mkdtempSync(join(tmpdir(), 'judge-calibration-'));
  try { return await fn(archiveDir); } finally { rmSync(archiveDir, { recursive: true, force: true }); }
};

test('calibration requires explicit unique labels and unambiguous Gherkin policies', async () => {
  assert.equal(planCalibration({ cases, labels }).length, 40);
  for (const bad of [
    {},
    { schemaVersion: 1, samples: [] },
    { schemaVersion: 1, samples: [{ ...labels.samples[0], expected: 'maybe' }] },
    { schemaVersion: 1, samples: [labels.samples[0], labels.samples[0]] },
    { schemaVersion: 1, samples: [labels.samples[0], { ...labels.samples[0], id: 'other' }] },
    { schemaVersion: 1, samples: [{ ...labels.samples[0], caseId: 'missing' }] },
  ]) assert.throws(() => planCalibration({ cases, labels: bad }), /calibration/);
  assert.throws(() => planCalibration({ cases: [...cases, cases[0]], labels }), /uniquely/);
  const dry = await calibrateJudge({ cases, labels, ...runtime, dryRun: true });
  assert.equal(dry.plannedSessions, 40);
  let calls = 0;
  await assert.rejects(calibrateJudge({
    cases, labels, ...runtime, approveSessions: 39, execute: async () => { calls++; },
  }), /exact approval/);
  assert.equal(calls, 0);
});

test('calibration recomputes accuracy and scope rather than trusting a saved eligible flag', () => temporary(async (archiveDir) => {
  const { calibration, reliability, storedPath } = await calibrateJudge({
    cases, labels, ...runtime, approveSessions: 40, execute, archiveDir,
  });
  assert.equal(reliability.eligible, true);
  assert.equal(reliability.correct, 40);
  assert.ok(storedPath.endsWith('.json'));
  assert.equal(assessCalibration(calibration, runtime).eligible, true);
  for (const mutation of [
    (x) => { x.entries.pop(); },
    (x) => { x.entries[0].sample.expected = 'fail'; },
    (x) => { x.entries[0].assessment.rawOutput = '{}'; },
    (x) => { x.entries[0].assessment.status = 'invalid'; },
    (x) => { x.entries[0].assessment.answerSha256 = '0'.repeat(64); },
    (x) => { x.entries[0].assessment.judgeSignature = '0'.repeat(64); },
    (x) => { x.entries[0].assessment.settings.tools = true; },
  ]) {
    const copy = structuredClone(calibration);
    copy.reliability = { eligible: true };
    mutation(copy);
    assert.equal(assessCalibration(copy, runtime).eligible, false);
  }
  assert.throws(() => assessCalibration(calibration, { ...runtime, model: 'other' }), /does not match/);
  assert.throws(() => assessCalibration(calibration, { ...runtime, timeoutMs: 1 }), /does not match/);
  assert.throws(() => assertCalibratedCases({
    calibration, cases: [{ ...cases[0], prompt: 'Changed task.' }], ...runtime,
  }), /not covered/);
}));

test('calibrated scores combine checks, preserve deterministic scores, and fail closed', () => temporary(async (archiveDir) => {
  const { calibration } = await calibrateJudge({ cases, labels, ...runtime, approveSessions: 40, execute, archiveDir });
  const trace = {
    caseId: cases[0].id, arm: 'with', repetition: 1,
    answer: 'new fail answer', valid: true, score: 1, invalidReason: null,
    checks: [{ name: 'literal', passed: true }],
  };
  const assessment = await judgeAnswer({
    answer: { caseId: trace.caseId, arm: trace.arm, repetition: 1, text: trace.answer, valid: true, complete: true },
    policy: { prompt: cases[0].prompt, criteria: cases[0].judgeCriteria },
    ...runtime, approveSessions: 1, execute,
  });
  const options = { report: { cases: [trace] }, cases, assessments: [assessment], calibration, ...runtime };
  const result = scoreJudgedAnswers(options);
  assert.equal(result.valid, true);
  assert.equal(result.traces[0].deterministicScore, 1);
  assert.equal(result.traces[0].score, 0.5);
  assert.equal(result.overallScore, 0.5);
  assert.equal(result.traces[0].checks[1].passed, false);
  assert.equal(trace.checks.length, 1, 'input is unchanged');
  for (const altered of [
    { ...options, assessments: [] },
    { ...options, assessments: [assessment, assessment] },
    { ...options, report: { cases: [{ ...trace, answer: 'tampered answer' }] } },
    { ...options, report: { cases: [{ ...trace, valid: false, invalidReason: 'invalid receipt' }] } },
    { ...options, assessments: [{ assessment: { ...assessment.assessment, settings: { ...assessment.assessment.settings, tools: true } } }] },
  ]) {
    const scored = scoreJudgedAnswers(altered);
    assert.equal(scored.valid, false);
    assert.equal(scored.overallScore, null);
    assert.equal(scored.cases[0].withScore, null);
  }
  const abstain = structuredClone(assessment);
  abstain.assessment.rawOutput = JSON.stringify({ criteria: [{ id: 'meaning', verdict: 'abstain', rationale: 'Uncertain.', evidence: [] }] });
  const nullScore = scoreJudgedAnswers({ ...options, assessments: [abstain] });
  assert.equal(nullScore.traces[0].score, null);
  assert.match(nullScore.traces[0].invalidReason, /abstained/);
  assert.equal(createHash('sha256').update(trace.answer).digest('hex'), assessment.assessment.answerSha256);
}));

test('recorded Gherkin CLI and calibrated archive scoring preserve invalid cases and original history', () => temporary(async (root) => {
  const { storedPath } = await calibrateJudge({ cases, labels, ...runtime, approveSessions: 40, execute, archiveDir: root });
  const configPath = join(root, 'evals.json');
  writeFileSync(configPath, JSON.stringify({ casesDir: 'cases', outputDir: 'runs' }));
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, JSON.stringify(labels));
  for (let i = 0; i < 5; i++) {
    const dir = join(root, 'cases', `choice-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cases.feature'), feature(i));
    writeFileSync(join(dir, 'case.samples.json'), JSON.stringify({ caseId: `case-${i}`, pass: ['answer'], fail: ['wrong'] }));
  }
  const cli = join(import.meta.dirname, '..', 'local', 'cli.mjs');
  const calibrationPlan = spawnSync(process.execPath, [cli, 'calibrate', '--config', configPath,
    '--client', runtime.client, '--model', runtime.model, '--labels', labelsPath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(calibrationPlan.status, 0, calibrationPlan.stderr);
  assert.equal(JSON.parse(calibrationPlan.stdout).plannedSessions, 40);
  assert.equal(existsSync(join(root, 'runs')), false);

  const runDir = join(root, 'run');
  mkdirSync(runDir);
  archivePolicy(runDir, cases, {});
  const normalized = '{"transport":"acp","client":"claude","overallScore":1}';
  writeFileSync(join(runDir, 'normalized.json'), normalized);
  const writeTrace = (id, valid) => {
    const directory = join(runDir, 'traces', id);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'with-1.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: `heldout answer for ${id}`, complete: true, toolCalls: [], raw: '' },
    }));
    writeFileSync(`${path}.receipt.json`, JSON.stringify({ valid, exitCode: valid ? 0 : 1 }));
    return path;
  };
  const tracePath = writeTrace('case-0', true);
  const traceBefore = readFileSync(tracePath, 'utf8');
  const args = [cli, 'judge', runDir, '--client', runtime.client, '--model', runtime.model, '--dry-run'];
  for (const extra of [[], ['--calibration', storedPath]]) {
    const plan = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).plannedSessions, 1);
  }
  const options = { runDir, parse: parseAcpTrace, calibrationPath: storedPath, ...runtime, approveSessions: 1, execute };
  const scored = await judgeArchive(options);
  assert.equal(scored.scoring.valid, true);
  assert.equal(scored.scoring.overallScore, 1);
  assert.equal(scored.scoring.traces[0].checks.length, 3);
  assert.ok(existsSync(scored.scorePath));
  writeTrace('case-1', false);
  const invalid = await judgeArchive(options);
  assert.equal(invalid.scoring.valid, false);
  assert.equal(invalid.scoring.overallScore, null);
  assert.equal(invalid.scoring.cases.find((c) => c.id === 'case-1').withScore, null);
  assert.equal(readFileSync(tracePath, 'utf8'), traceBefore);
  assert.equal(readFileSync(join(runDir, 'normalized.json'), 'utf8'), normalized);
}));
