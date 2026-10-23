import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheck, extractCommitSubject } from '../local/assertions.mjs';
import { gradeSample, validateCapabilities, validateCase, validateCheck } from '../local/contract.mjs';
import { gradeTranscript } from '../local/grade.mjs';

const v2 = (checks) => ({
  schemaVersion: 2,
  id: 'assertion-case',
  prompt: 'Write a commit message',
  shouldTrigger: false,
  checks,
});
const check = (type, fields = {}, name = 'check') => ({ type, name, ...fields });
const transcript = (finalText, extra = {}) => ({ finalText, raw: finalText, toolCalls: [], ...extra });

test('v2 length checks use inclusive and exclusive Unicode code-point boundaries', () => {
  const sample = (length) => 'x'.repeat(length);
  const maximum = check('max_length', { limit: 72 });
  const lessThan = check('length_less_than', { limit: 72 });

  assert.equal(evaluateCheck(maximum, transcript(sample(71))).passed, true);
  assert.equal(evaluateCheck(maximum, transcript(sample(72))).passed, true);
  assert.equal(evaluateCheck(maximum, transcript(sample(73))).passed, false);
  assert.equal(evaluateCheck(lessThan, transcript(sample(71))).passed, true);
  assert.equal(evaluateCheck(lessThan, transcript(sample(72))).passed, false);
  assert.equal(evaluateCheck(lessThan, transcript('😀'.repeat(72))).passed, false);
  assert.equal(evaluateCheck(check('max_length', { limit: 1 }), transcript('😀')).passed, true);
});

test('v2 text assertions are case-sensitive and do not trim input', () => {
  const text = transcript('  Feat: Add a thing');
  assert.equal(evaluateCheck(check('starts_with', { value: 'Feat' }), text).passed, false);
  assert.equal(evaluateCheck(check('contains', { value: 'Feat' }), text).passed, true);
  assert.equal(evaluateCheck(check('contains', { value: 'feat' }), text).passed, false);
  assert.equal(evaluateCheck(check('not_contains', { value: 'feat' }), text).passed, true);
});

test('v2 commit checks support scope and breaking markers and inspect description initial only', () => {
  const message = transcript('feat(core)!: add support\n\nBody may Begin with uppercase.');
  assert.equal(evaluateCheck(check('conventional_header', { types: ['feat', 'fix'], target: 'commit_subject' }), message).passed, true);
  assert.equal(evaluateCheck(check('conventional_header', { types: ['fix'], target: 'commit_subject' }), message).passed, false);
  assert.equal(evaluateCheck(check('lowercase_initial', { target: 'commit_subject' }), message).passed, true);
  assert.equal(evaluateCheck(check('lowercase_initial', { target: 'commit_subject' }), transcript('feat: Add a thing')).passed, false);
  assert.equal(evaluateCheck(check('lowercase_initial', { target: 'commit_subject' }), transcript('feat: éclair')).passed, true);
});

test('commit subject extraction accepts one plain or fenced message and rejects ambiguous suggestions', () => {
  assert.deepEqual(extractCommitSubject('feat: first line\n\nBody with another: line'), { subject: 'feat: first line' });
  assert.deepEqual(extractCommitSubject('Proposed:\n```text\nfeat(core)!: add thing\n\nBody\n```'), {
    subject: 'feat(core)!: add thing',
  });
  assert.match(extractCommitSubject('```text\nfeat: one\n```\n```text\nfix: two\n```').error, /multiple fenced/);
  assert.match(extractCommitSubject('Options:\n1. feat: one\n2. fix: two').error, /ambiguous/);
  assert.match(extractCommitSubject('feat: one\nfix: two').error, /multiple commit subjects/);
  assert.match(extractCommitSubject('').error, /missing/);
});

test('ambiguous complete commit answers fail checks but remain valid grading results', () => {
  const c = v2([
    check('conventional_header', { types: ['feat', 'fix'], target: 'commit_subject' }, 'header'),
  ]);
  const answer = [
    'Here are two alternatives:',
    '```text',
    'feat: add the first option',
    '```',
    '```text',
    'fix: add the second option',
    '```',
  ].join('\n');

  const evaluated = evaluateCheck(c.checks[0], transcript(answer));
  assert.equal(evaluated.passed, false);
  assert.match(evaluated.diagnostic, /ambiguous/);

  const graded = gradeTranscript(c, transcript(answer));
  assert.equal(graded.invalid, false);
  assert.equal(graded.score, 0.5);
  assert.equal(graded.checks.find((item) => item.name === 'header').passed, false);

  const noSubject = gradeTranscript(c, transcript(''));
  assert.equal(noSubject.invalid, false);
  assert.equal(noSubject.checks.find((item) => item.name === 'header').passed, false);
});

test('missing execution answer evidence remains invalid', () => {
  const c = v2([check('conventional_header', { types: ['feat'], target: 'commit_subject' })]);
  const graded = gradeTranscript(c, { raw: '', toolCalls: [] });
  assert.equal(graded.invalid, true);
  assert.equal(graded.score, null);
  assert.match(graded.errors[0].diagnostic, /final message evidence is missing/);
});

test('v2 validation enforces check names, unique IDs and valid regular expressions', () => {
  assert.deepEqual(validateCheck(check('contains', { value: 'x' })), []);
  assert.notDeepEqual(validateCheck(check('contains', {})), []);
  assert.notDeepEqual(validateCheck(check('regex', { pattern: '[' })), []);
  assert.notDeepEqual(validateCase(v2([check('contains', { value: 'x' }), check('contains', { value: 'y' })])), []);
  assert.deepEqual(validateCase(v2([check('contains', { value: 'x' }, 'one'), check('starts_with', { value: 'x' }, 'two')])), []);
});

test('validation errors identify the case check by index and name', () => {
  const current = v2([check('regex', {}, 'missing-pattern')]);
  assert.equal(validateCase(current).length, 1);
  assert.match(validateCase(current)[0], /checks\[0\] \(missing-pattern\).*pattern/);
});

test('v2 grading marks absent required evidence invalid instead of skipping it', () => {
  const c = v2([
    check('tool_order', { before: 'Read', after: 'Edit' }, 'order'),
    check('file_exists', { path: 'result.txt' }, 'file'),
  ]);
  const result = gradeTranscript(c, { finalText: 'answer', raw: 'answer' });
  assert.equal(result.score, null);
  assert.equal(result.invalid, true);
  assert.equal(result.errors.length, 3);
  assert.equal(gradeSample(c, 'answer').invalid, true);
  assert.deepEqual(validateCapabilities(c, {}), [
    'checks[0] (order): tool_order requires toolEvidence capability',
    'checks[1] (file): file_exists requires fileSnapshot capability',
  ]);
});

test('v2 grading scores available deterministic checks and preserves sample failures', () => {
  const c = v2([check('contains', { value: 'answer' }, 'has-answer')]);
  assert.deepEqual(gradeSample(c, 'an answer'), { passed: true, failed: [], invalid: false, errors: [] });
  assert.deepEqual(gradeSample(c, 'no match'), { passed: false, failed: ['has-answer'], invalid: false, errors: [] });
  assert.equal(gradeTranscript(c, transcript('an answer')).score, 1);
});

test('grading refuses obsolete or unversioned cases rather than silently applying compatibility policy', () => {
  for (const schemaVersion of [undefined, 1]) {
    const c = { ...v2([check('regex', { pattern: '^feat:' }, 'header')]), schemaVersion };
    assert.notDeepEqual(validateCase(c), []);
    assert.throws(() => gradeSample(c, 'feat: add'), /only compiled schemaVersion 2/);
    assert.throws(() => gradeTranscript(c, transcript('feat: add')), /only compiled schemaVersion 2/);
  }
});
