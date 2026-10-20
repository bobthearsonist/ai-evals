import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeTrace, gradeTranscript } from '../local/grade.mjs';
import { regradeRun } from '../local/regrade.mjs';
import { registerStubs } from '../local/stubs.mjs';
import { getRunner } from '../local/contract.mjs';

const line = (o) => JSON.stringify(o);
const trace = (answer, { skill = true, done = true } = {}) => [
  line({ type: 'assistant', message: { content: skill ? [{ type: 'tool_use', name: 'Skill', input: { skill: 'x' } }] : [] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }),
  done ? line({ type: 'result', result: answer }) : '',
].join('\n');

const c = {
  id: 'k', shouldTrigger: true,
  checks: [{ type: 'regex', pattern: '^feat: ', flags: 'm', name: 'h' }, { type: 'not_regex', pattern: 'oops', name: 'n' }],
};

test('parseClaudeTrace extracts final text, tool calls and completeness', () => {
  const t = parseClaudeTrace(trace('feat: x'));
  assert.equal(t.finalText, 'feat: x');
  assert.deepEqual(t.toolCalls.map((x) => x.name), ['Skill']);
  assert.equal(t.complete, true);
  assert.equal(parseClaudeTrace(trace('a', { done: false })).complete, false);
});

test('gradeTranscript is deterministic and covers trigger and canary', () => {
  const good = parseClaudeTrace(trace('feat: x'));
  assert.equal(gradeTranscript(c, good, { arm: 'with', canaryToken: 'zzz' }).score, 1);
  assert.equal(gradeTranscript(c, good, { arm: 'with', canaryToken: 'zzz' }).score, 1);
  const bad = parseClaudeTrace(trace('oops', { skill: false }));
  const g = gradeTranscript(c, bad, { arm: 'with' });
  assert.deepEqual(g.checks.filter((k) => !k.passed).map((k) => k.name), ['h', 'n', 'skill-trigger']);
  assert.equal(gradeTranscript(c, parseClaudeTrace(trace('feat: x zzz')), { arm: 'without', canaryToken: 'zzz' }).checks.at(-1).passed, false);
});

test('regradeRun grades archived traces offline and excludes incomplete runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-'));
  mkdirSync(join(dir, 'k'));
  writeFileSync(join(dir, 'k', 'with-1.jsonl'), trace('feat: x'));
  writeFileSync(join(dir, 'k', 'without-1.jsonl'), trace('oops', { skill: false }));
  writeFileSync(join(dir, 'k', 'without-2.jsonl'), trace('a', { done: false }));
  const [r] = regradeRun({ tracesDir: dir, cases: [c], parse: parseClaudeTrace });
  assert.equal(r.withScore, 1);
  assert.equal(r.withoutScore, 0);
  assert.equal(r.invalidRuns, 1);
  assert.equal(r.verdict, 'lift');
});

test('every registered adapter exposes the driver interface', () => {
  registerStubs();
  for (const id of ['copilot', 'opencode']) {
    const r = getRunner(id);
    for (const m of ['preflight', 'plannedSessions', 'prepare', 'parseTrace', 'run']) assert.equal(typeof r[m], 'function', `${id}.${m}`);
  }
});
