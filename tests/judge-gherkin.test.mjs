import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFeature } from '../local/suite.mjs';
import { validateCase, gradeSample } from '../local/contract.mjs';
import {
  JUDGE_PROMPT, JUDGE_PROMPT_SHA256, buildJudgePrompt, judgePolicy, judgePolicySha256,
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

const assertionTable = `Then the AI judge verifies:
      | id         | action           | expectation                              |
      | problem    | identifies       | No demonstrated maintenance problem      |
      | advice     | recommends       | Keep the conditionals for now            |
      | rationale  | explains         | Added machinery has no demonstrated need |
      | revisit    | conditions       | Refactor when concrete problems emerge   |
      | speculative | does not endorse | Add abstractions just in case           |`;
const withAssertions = (steps = assertionTable) => source.replace(
  /Then the AI judge confirms "reasoning":[\s\S]*$/,
  `${steps}\n    And the response contains "change"\n`,
);

test('semantic action rows expand shared definitions into independent judge criteria', () => {
  const [compiled] = compileFeature(withAssertions());
  assert.deepEqual(compiled.judgeCriteria, [
    { id: 'problem', text: 'The response must recognize the specified problem, concept, or fact. Merely repeating the question does not establish recognition.\nExpectation: No demonstrated maintenance problem' },
    { id: 'advice', text: 'The response must advise the specified course of action. Merely describing an option or quoting someone else\'s advice is insufficient.\nExpectation: Keep the conditionals for now' },
    { id: 'rationale', text: 'The response must explain the specified relationship or rationale. Mentioning its components without connecting them is insufficient.\nExpectation: Added machinery has no demonstrated need' },
    { id: 'revisit', text: 'The response must make the specified action dependent on the specified prerequisite. Mentioning the action and prerequisite separately is insufficient.\nExpectation: Refactor when concrete problems emerge' },
    { id: 'speculative', text: 'The response must not advocate the specified position anywhere in the answer. Merely quoting, discussing, or rejecting that position is not endorsement. The response need not explicitly reject or mention it to satisfy this criterion.\nExpectation: Add abstractions just in case' },
  ]);
  assert.deepEqual(validateCase(compiled), []);
  assert.deepEqual(compiled.checks, [c.checks[0]]);
  assert.equal(gradeSample(compiled, 'change').passed, true);
  assert.equal(gradeSample(compiled, 'no').passed, false);
  assert.equal(compiled.prompt, c.prompt);
  assert.deepEqual(judgePolicy(compiled).criteria, compiled.judgeCriteria);
  const shifted = compileFeature(`\n${withAssertions()}`)[0];
  assert.deepEqual(shifted.judgeCriteria, compiled.judgeCriteria);
  assert.equal(judgePolicySha256(judgePolicy(shifted)), judgePolicySha256(judgePolicy(compiled)));
  const changed = compileFeature(withAssertions().replace('Keep the conditionals for now', 'Introduce Strategy now'))[0];
  assert.notEqual(judgePolicySha256(judgePolicy(changed)), judgePolicySha256(judgePolicy(compiled)));
});

test('semantic assertion tables and Doc Strings share the criterion ID namespace', () => {
  const docString = `And the AI judge confirms "freeform":
      """
      Gives one concrete example.
      """`;
  const [mixed] = compileFeature(withAssertions(`${assertionTable}\n    ${docString}`));
  assert.equal(mixed.judgeCriteria.length, 6);
  assert.deepEqual(mixed.judgeCriteria.at(-1), { id: 'freeform', text: 'Gives one concrete example.' });
  assert.throws(() => compileFeature(withAssertions(`${assertionTable}\n    ${docString.replace('"freeform"', '"advice"')}`)),
    /duplicate judge criterion advice/);
  assert.throws(() => compileFeature(withAssertions(`${docString.replace('And ', 'Then ')}\n    ${assertionTable.replace('Then ', 'And ').replace('advice ', 'freeform ')}`)),
    /duplicate judge criterion freeform/);
  assert.throws(() => compileFeature(withAssertions(assertionTable.replace('rationale ', 'advice    '))),
    /duplicate judge criterion advice/);
});

for (const [name, steps, message] of [
  ['wrong headers', assertionTable.replace('| id ', '| key'), /id, action, expectation header/],
  ['reordered headers', assertionTable.replace('| id         | action', '| action     | id    '), /id, action, expectation header/],
  ['extra column', assertionTable.replaceAll('\n      |', '\n      | extra |'), /three-column/],
  ['inconsistent columns', assertionTable.replace('| id         |', '| extra | id         |'), /inconsistent cell count/],
  ['header only', 'Then the AI judge verifies:\n      | id | action | expectation |', /at least one/],
  ['empty id', assertionTable.replace('| problem ', '|         '), /explicit kebab-case id/],
  ['invalid id', assertionTable.replace('| problem ', '| Bad_ID  '), /explicit kebab-case id/],
  ['unknown action', assertionTable.replace('identifies', 'mentions'), /unsupported action "mentions"/],
  ['prototype action', assertionTable.replace('identifies', 'constructor'), /unsupported action "constructor"/],
  ['wrong action case', assertionTable.replace('identifies', 'Identifies'), /unsupported action "Identifies"/],
  ['empty action', assertionTable.replace('identifies', '          '), /unsupported action ""/],
  ['empty expectation', assertionTable.replace('No demonstrated maintenance problem', '                                  '), /non-empty expectation/],
  ['missing table', 'Then the AI judge verifies:', /dataTable/],
  ['Doc String instead of table', 'Then the AI judge verifies:\n      """\n      A requirement.\n      """', /dataTable/],
  ['wrong phase', assertionTable.replace('Then ', 'When '), /belongs in Outcome/],
]) {
  test(`semantic assertion tables reject ${name} offline with a source location`, () => {
    assert.throws(() => compileFeature(withAssertions(steps), { uri: 'actions.feature' }), (error) => {
      assert.match(error.message, /^actions\.feature:\d+:\d+:/);
      assert.match(error.message, message);
      return true;
    });
  });
}

test('Scenario Outlines expand semantic assertion IDs and expectations before judging', () => {
  const outline = withAssertions(assertionTable)
    .replace('@case:advice', '@case:advice-<id>')
    .replace('Scenario: Explain a choice', 'Scenario Outline: Explain <choice>')
    .replace('| advice     |', '| advice-<id> |')
    .replace('Keep the conditionals for now', '<choice>')
    .concat('    Examples:\n      | id | choice |\n      | small | Keep the conditionals |\n      | large | Extract Strategy |\n');
  const expanded = compileFeature(outline);
  assert.deepEqual(expanded.map(({ id }) => id), ['advice-small', 'advice-large']);
  assert.deepEqual(expanded.map(({ judgeCriteria }) => judgeCriteria[1].id), ['advice-small', 'advice-large']);
  assert.match(expanded[0].judgeCriteria[1].text, /Expectation: Keep the conditionals$/);
  assert.match(expanded[1].judgeCriteria[1].text, /Expectation: Extract Strategy$/);
});

test('expanded semantic actions flow through the existing judge planner and verdict contract', async () => {
  const [compiled] = compileFeature(withAssertions());
  const answer = { text: 'change', valid: true, complete: true, caseId: compiled.id, arm: 'with', repetition: 1 };
  const plan = planJudgeRequests({ answers: [answer], cases: [compiled] });
  assert.equal(plan.plannedSessions, 1, 'rows share one request, not one session per row');
  const resolved = plan.requests[0].policy;
  const result = await judgeAnswer({
    answer, policy: resolved, model: 'test', client: 'claude', approveSessions: 1,
    execute: async ({ prompt }) => {
      assert.ok(prompt.includes(JSON.stringify(resolved)));
      return {
        complete: true, model: 'test', errors: [], toolCalls: [],
        finalText: JSON.stringify({
          criteria: resolved.criteria.map(({ id }) => ({
            id, evidence: ['change'], rationale: 'Test verdict.', verdict: id === 'revisit' ? 'fail' : 'pass',
          })),
        }),
      };
    },
  });
  assert.equal(result.status, 'judged');
  assert.equal(result.assessment.verdict, 'fail');
  assert.deepEqual(result.assessment.policy, resolved);
  assert.equal(result.assessment.criteria.length, 5);
});

test('top-level visible prompt is the actual runtime source and task context is included', () => {
  assert.equal(JUDGE_PROMPT, readFileSync(new URL('../JUDGE_PROMPT.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
  assert.ok(!JUDGE_PROMPT.includes('\r'));
  assert.ok(!JUDGE_PROMPT.includes('```'), 'the output example must not encourage Markdown fences');
  assert.match(JUDGE_PROMPT, /clear implication or paraphrase/);
  assert.match(JUDGE_PROMPT, /genuinely unmet claim/);
  assert.match(JUDGE_PROMPT, /If the criterion accepts a proposed\s+method, assess that method/);
  assert.match(JUDGE_PROMPT, /evidence first, then the coverage rationale, then the verdict/);
  const shape = JSON.parse(JUDGE_PROMPT.split('\n').find((line) => line.startsWith('{"criteria":')));
  assert.deepEqual(Object.keys(shape.criteria[0]), ['id', 'evidence', 'rationale', 'verdict']);
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
