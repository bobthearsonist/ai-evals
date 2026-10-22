import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verdict } from '../local/grade.mjs';
import { recordRun, diffRuns } from '../local/summary.mjs';

test('verdict separates lift, regression, same, inconclusive, unmeasured', () => {
  assert.equal(verdict([1, 1, 1], [0.5, 0.5, 0.67]), 'lift');
  assert.equal(verdict([0.2, 0.3], [0.8, 0.9]), 'regression');
  assert.equal(verdict([1, 1], [1, 1]), 'same');
  assert.equal(verdict([1, 0.5, 1], [0.5, 1, 0.5]), 'inconclusive');
  assert.equal(verdict([], [1]), 'unmeasured');
});

test('recordRun writes history and diffs against previous latest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'res-'));
  const mk = (w, v) => ({ status: 'passed', cases: [{ id: 'a', withScore: w, withoutScore: 0.5, delta: w - 0.5, verdict: v, withRuns: [w], withoutRuns: [0.5], invalidRuns: 0 }] });
  assert.deepEqual(recordRun(dir, 's', mk(1, 'lift')).diff, []);
  const second = recordRun(dir, 's', mk(0.5, 'same'));
  assert.equal(second.diff[0].verdictChange, 'lift -> same');
  assert.equal(second.diff[0].withChange, -0.5);
  assert.equal(readdirSync(join(dir, 'acp', 's')).length, 3);
  assert.deepEqual(diffRuns(null, second.current), []);
});
