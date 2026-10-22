import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archivedJudgeAnswers, judgeArchive } from '../local/judge-cli.mjs';

function temporary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'eval-judge-cli-'));
  return Promise.resolve().then(() => fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function archive(root, receipt) {
  const dir = join(root, 'traces', 'greeting');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'with-1.jsonl');
  writeFileSync(path, JSON.stringify({ finalText: 'hello', toolCalls: [], complete: true }));
  if (receipt) writeFileSync(`${path}.receipt.json`, JSON.stringify(receipt));
  return path;
}

test('judge archive adapter requires trusted receipts for audited runtimes', () => temporary((root) => {
  archive(root);
  const options = { runDir: root, parse: JSON.parse, requireReceipt: true };
  assert.equal(archivedJudgeAnswers(options)[0].valid, false);
  archive(root, { valid: true, exitCode: 0 });
  assert.equal(archivedJudgeAnswers(options)[0].valid, true);
  archive(root, { valid: true, exitCode: 0, cancelled: true });
  assert.equal(archivedJudgeAnswers(options)[0].valid, false);
  assert.throws(() => archivedJudgeAnswers({ ...options, caseIds: ['missing'] }), /unknown or empty/);
}));

test('judge archive adapter preserves incomplete and error evidence as ineligible', () => temporary((root) => {
  const path = archive(root, { valid: true, exitCode: 0 });
  writeFileSync(path, JSON.stringify({ finalText: 'hello', complete: false, errors: ['transport failed'] }));
  const [answer] = archivedJudgeAnswers({ runDir: root, parse: JSON.parse, requireReceipt: true });
  assert.equal(answer.complete, false);
  assert.equal(answer.valid, false);
  assert.equal(answer.repetition, 1);
}));

test('judge CLI demands independent opt-in and leaves captured evidence untouched', () => temporary((root) => {
  const path = archive(root);
  const before = readFileSync(path, 'utf8');
  writeFileSync(join(root, 'normalized.json'), JSON.stringify({ client: 'claude', overallScore: 1 }));
  const rubric = join(root, 'rubric.txt');
  writeFileSync(rubric, 'Say hello.');
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'judge', root, '--rubric', rubric], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit --client and --model/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(join(root, 'normalized.json'), 'utf8')).overallScore, 1);
}));

test('judge approval rejects before an execution seam can be invoked', () => temporary(async (root) => {
  archive(root);
  const rubricPath = join(root, 'rubric.txt');
  writeFileSync(rubricPath, 'Say hello.');
  let calls = 0;
  await assert.rejects(judgeArchive({
    runDir: root, parse: JSON.parse, rubricPath, client: 'copilot', model: 'test-model', approveSessions: 0,
    execute: async () => { calls++; throw new Error('must not execute'); },
  }), /approv/i);
  assert.equal(calls, 0);
}));

test('judge CLI dry-run counts eligible answers without starting a client', () => temporary((root) => {
  const path = archive(root);
  writeFileSync(path, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'result', result: 'hello' }),
  ].join('\n'));
  writeFileSync(join(root, 'normalized.json'), JSON.stringify({ client: 'claude' }));
  const rubric = join(root, 'rubric.txt');
  writeFileSync(rubric, 'Say hello.');
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const mappedRubric = join(root, 'rubrics.json');
  writeFileSync(mappedRubric, JSON.stringify({ greeting: 'Say hello.' }));
  for (const rubricPath of [rubric, mappedRubric]) {
    const proc = spawnSync(process.execPath, [cli, 'judge', root, '--client', 'claude',
      '--model', 'fake-model', '--rubric', rubricPath, '--dry-run'], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(JSON.parse(proc.stdout).plannedSessions, 1);
  }
  assert.equal(existsSync(join(root, 'assessments')), false);
}));

test('judge archive adapter writes separate assessments and never mutates candidate scores', () => temporary(async (root) => {
  const path = archive(root, { valid: true, exitCode: 0 });
  const before = readFileSync(path, 'utf8');
  const rubricPath = join(root, 'rubric.txt');
  writeFileSync(rubricPath, 'Say hello.');
  const normalized = '{"client":"copilot","overallScore":0.5}';
  writeFileSync(join(root, 'normalized.json'), normalized);
  let calls = 0;
  const options = {
    runDir: root, parse: JSON.parse, requireReceipt: true, rubricPath, client: 'claude', model: 'test-model', approveSessions: 1,
    execute: async ({ model, mode }) => {
      calls++;
      assert.equal(mode, 'judge');
      return {
        finalText: JSON.stringify({ verdict: 'pass', rationale: 'Matches.', evidence: ['hello'] }),
        complete: true, model, toolCalls: [], errors: [], raw: [], usage: null,
      };
    },
  };
  const first = await judgeArchive(options);
  const second = await judgeArchive(options);
  assert.equal(calls, 2);
  assert.equal(first.assessments[0].judgement.verdict, 'pass');
  assert.notEqual(first.assessments[0].storedPath, second.assessments[0].storedPath);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readFileSync(join(root, 'normalized.json'), 'utf8'), normalized);
}));

test('per-case JSON rubrics select semantic cases and preserve independent approvals', () => temporary(async (root) => {
  const original = archive(root, { valid: true, exitCode: 0 });
  const other = join(root, 'traces', 'exact-format');
  mkdirSync(other);
  writeFileSync(join(other, 'with-1.jsonl'), JSON.stringify({ finalText: 'format', complete: true }));
  const rubricPath = join(root, 'rubrics.json');
  const rubric = 'Greet the visitor warmly; equivalent phrasings are acceptable.';
  writeFileSync(rubricPath, JSON.stringify({ greeting: rubric }));
  const options = { runDir: root, parse: JSON.parse, rubricPath, client: 'claude', model: 'test-model' };
  const plan = await judgeArchive({ ...options, dryRun: true });
  assert.equal(plan.plannedSessions, 1);
  assert.ok(plan.skipped.some((s) => s.caseId === 'exact-format' && s.reason.includes('rubric')));
  assert.equal(existsSync(join(root, 'assessments')), false);
  let calls = 0;
  const execute = async ({ prompt, model }) => {
    calls++;
    assert.ok(prompt.includes(rubric));
    assert.ok(!prompt.includes('exact-format'));
    return {
      complete: true, model, errors: [], toolCalls: [],
      finalText: JSON.stringify({ verdict: 'pass', rationale: 'A greeting.', evidence: ['hello'] }),
    };
  };
  await assert.rejects(judgeArchive({ ...options, execute, approveSessions: 2 }), /approval/i);
  assert.equal(calls, 0);
  const before = readFileSync(original, 'utf8');
  const result = await judgeArchive({ ...options, execute, approveSessions: 1 });
  assert.equal(calls, 1);
  assert.equal(result.assessments[0].judgement.verdict, 'pass');
  assert.equal(readFileSync(original, 'utf8'), before);
}));

test('JSON rubric mistakes and explicit unmapped selections fail before execution', () => temporary(async (root) => {
  archive(root);
  const rubricPath = join(root, 'rubrics.json');
  let calls = 0;
  const options = {
    runDir: root, parse: JSON.parse, rubricPath, client: 'claude', model: 'test-model',
    approveSessions: 0, execute: async () => { calls++; },
  };
  for (const bad of [{}, [], null, { greeting: '' }, { greeting: 1 }, { 'bad id': 'hello' }]) {
    writeFileSync(rubricPath, JSON.stringify(bad));
    await assert.rejects(judgeArchive(options), /JSON judge rubric must map/);
  }
  writeFileSync(rubricPath, '{');
  await assert.rejects(judgeArchive(options), SyntaxError);
  writeFileSync(rubricPath, JSON.stringify({ unrelated: 'Say goodbye.' }));
  await assert.rejects(judgeArchive({ ...options, caseIds: ['greeting'] }), /selected case has no rubric/);
  const textPath = join(root, 'rubric.txt');
  writeFileSync(textPath, ' \n');
  await assert.rejects(judgeArchive({ ...options, rubricPath: textPath }), /must not be empty/);
  assert.equal(calls, 0);
}));
