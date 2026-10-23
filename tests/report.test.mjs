import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archivePolicy } from '../local/policy.mjs';
import { reportRun, renderReport } from '../local/report.mjs';

const caseDefinition = {
  schemaVersion: 2,
  id: 'greeting',
  prompt: 'Say hello.',
  shouldTrigger: true,
  checks: [{ name: 'greeting-text', type: 'contains', value: 'hello' }],
};

test('report grades archived checks, reports Skill calls, and optionally includes answers', () => {
  const root = join(import.meta.dirname, 'fixtures', `.report-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(root, { recursive: true });
    archivePolicy(root, [caseDefinition], { suite: 'demo' });
    writeFileSync(join(root, 'normalized.json'), JSON.stringify({ suite: 'demo', client: 'claude', canaryToken: 'canary' }));
    const traces = join(root, 'traces', 'greeting');
    mkdirSync(traces, { recursive: true });
    const tracePath = join(traces, 'with-1.jsonl');
    writeFileSync(tracePath, JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: 'hello there', toolCalls: [{ name: 'Skill' }], raw: 'used skill', complete: true },
    }));
    writeFileSync(`${tracePath}.receipt.json`, JSON.stringify({ valid: true, exitCode: 0 }));
    const failedPath = join(traces, 'without-1.jsonl');
    writeFileSync(failedPath, JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: 'goodbye', toolCalls: [], raw: 'no skill', complete: true },
    }));
    writeFileSync(`${failedPath}.receipt.json`, JSON.stringify({ valid: true, exitCode: 0 }));

    const result = reportRun(root);
    assert.equal(result.cases.length, 2);
    const passed = result.cases.find((item) => item.arm === 'with');
    const failed = result.cases.find((item) => item.arm === 'without');
    assert.equal(passed.skillLoaded, true);
    assert.deepEqual(passed.checks.map(({ name, passed }) => [name, passed]), [
      ['greeting-text', true], ['skill-trigger', true], ['canary', true],
    ]);
    assert.equal(failed.skillLoaded, false);
    assert.equal(failed.checks[0].passed, false);
    assert.match(failed.checks[0].reason, /expected response to contain/);
    const rendered = renderReport(result);
    assert.match(rendered, /\| greeting \| with-1 \| valid \| yes \(1\) \| greeting-text \| PASS \| matched response to contain/);
    assert.match(rendered, /\| greeting \| without-1 \| valid \| no \(0\) \| greeting-text \| FAIL \| expected response to contain/);
    assert.equal(reportRun(root, { includeAnswer: true }).cases.find((item) => item.arm === 'with').answer, 'hello there');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
