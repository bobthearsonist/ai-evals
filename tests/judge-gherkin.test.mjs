import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFeature } from '../local/suite.mjs';
import { validateCase, gradeSample } from '../local/contract.mjs';
import {
  JUDGE_PROMPT, JUDGE_PROMPT_SHA256, buildJudgePrompt, judgePolicy,
  judgeAnswer, planJudgeRequests, validateJudgement,
} from '../local/judge.mjs';

const source = `Feature: Advice
  @case:advice @should-not-trigger
  Scenario: Explain a choice
    When the user asks:
      """
      Explain why a small change is enough.
      """
    Then the AI judge confirms "reasoning":
      """
      Justifies the small change instead of recommending a rewrite.
      """
    And the response contains "change"
    And the AI judge confirms:
      """
      Identifies a concrete tradeoff.
      """
`;
const [c] = compileFeature(source);
const policy = judgePolicy(c);
const output = (verdicts = ['pass', 'pass']) => JSON.stringify({
  criteria: policy.criteria.map(({ id }, i) => ({
    id, verdict: verdicts[i], rationale: 'Reason.', evidence: ['change'],
  })),
});

test('Gherkin compiles semantic Doc Strings separately from deterministic checks', () => {
  assert.equal(c.checks.length, 1);
  assert.equal(c.judgeCriteria.length, 2);
  assert.equal(c.judgeCriteria[0].id, 'reasoning');
  assert.match(c.judgeCriteria[1].id, /^meaning-[a-f0-9]{12}$/);
  assert.equal(c.judgeCriteria[1].id, compileFeature(`\n${source}`)[0].judgeCriteria[1].id);
  assert.deepEqual(validateCase(c), []);
  assert.equal(gradeSample(c, 'change').passed, true);
  assert.ok(!c.prompt.includes('tradeoff'));
  assert.throws(() => compileFeature(source.replace('Identifies a concrete tradeoff.', '   ')), /\\S|pattern/);
  assert.throws(() => compileFeature(source.replace('the AI judge confirms:', 'the AI judge confirms "reasoning":')), /duplicate judge criterion/);
  assert.throws(() => compileFeature(source.replace('"reasoning"', '"Bad id"')), /pattern/);
});

test('top-level visible prompt is the actual runtime source and task context is included', () => {
  assert.equal(JUDGE_PROMPT, readFileSync(new URL('../JUDGE_PROMPT.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
  assert.ok(!JUDGE_PROMPT.includes('\r'));
  assert.ok(!JUDGE_PROMPT.includes('```'), 'the output example must not encourage Markdown fences');
  assert.match(JUDGE_PROMPT, /clear implication or paraphrase/);
  assert.match(JUDGE_PROMPT, /genuinely unmet claim/);
  assert.equal(JUDGE_PROMPT_SHA256.length, 64);
  const prompt = buildJudgePrompt({
    answer: { text: 'change', valid: true, complete: true, caseId: c.id, arm: 'with', repetition: 1 },
    policy,
  });
  assert.ok(prompt.startsWith(JUDGE_PROMPT));
  assert.ok(prompt.includes(JSON.stringify(policy)));
});

test('judge validates exact criterion coverage and host derives aggregate verdict', () => {
  assert.equal(validateJudgement(output(), 'change', policy).judgement.verdict, 'pass');
  assert.equal(validateJudgement(output(['pass', 'fail']), 'change', policy).judgement.verdict, 'fail');
  assert.equal(validateJudgement(output(['pass', 'abstain']), 'change', policy).judgement.verdict, 'abstain');
  for (const mutate of [
    (x) => x.criteria.pop(),
    (x) => x.criteria.push(x.criteria[0]),
    (x) => { x.criteria[0].id = 'invented'; },
    (x) => { x.verdict = 'pass'; },
    (x) => { x.criteria[0].evidence = []; },
    (x) => { x.criteria[0].evidence = ['fabricated']; },
  ]) {
    const parsed = JSON.parse(output());
    mutate(parsed);
    assert.ok(validateJudgement(JSON.stringify(parsed), 'change', policy).reason);
  }
  assert.equal(validateJudgement(`\`\`\`json\n${output()}\n\`\`\``, 'change', policy).reason,
    'judge output is not valid JSON', 'fenced output must remain invalid');
});

test('Gherkin planner selects semantic cases and archives criterion provenance', async () => {
  const answer = { text: 'change', valid: true, complete: true, caseId: c.id, arm: 'with', repetition: 1 };
  const plan = planJudgeRequests({ answers: [answer, { ...answer, caseId: 'other' }], cases: [c] });
  assert.equal(plan.plannedSessions, 1);
  assert.match(plan.skipped[0].reason, /Gherkin/);
  const result = await judgeAnswer({
    answer, policy: plan.requests[0].policy, model: 'test', client: 'claude', approveSessions: 1,
    execute: async () => ({ complete: true, model: 'test', errors: [], toolCalls: [], finalText: output() }),
  });
  assert.equal(result.status, 'judged');
  assert.deepEqual(result.assessment.policy, policy);
  assert.equal(result.assessment.criteria.length, 2);
});
