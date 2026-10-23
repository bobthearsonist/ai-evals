import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFeature, loadSuite } from '../local/suite.mjs';
import { gradeSample } from '../local/contract.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gherkin');
const feature = readFileSync(join(fixtureDir, 'commit.feature'), 'utf8');
const samples = JSON.parse(readFileSync(join(fixtureDir, 'commit.samples.json'), 'utf8'));
const minimal = (steps = 'Then the response contains "hello"', tags = '@case:hello @should-trigger') => `Feature: Responses
  ${tags}
  Scenario: Hello
    When the user asks:
      """
      Say hello.
      """
    ${steps}
`;
const compile = (source) => compileFeature(source, { uri: 'example.feature' });
const withSuite = (files, run) => {
  const dir = join(fixtureDir, `.work-${randomUUID()}`);
  mkdirSync(dir);
  try {
    for (const [name, value] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const sample = (caseId = 'hello') => ({ caseId, pass: ['hello'], fail: ['no'] });

test('official parser compiles Gherkin to the normalized v2 policy', () => {
  const [c] = compile(feature);
  const { source, ...plan } = c;
  assert.deepEqual(plan, {
    schemaVersion: 2,
    id: 'explicit-positive',
    shouldTrigger: true,
    prompt: 'Write me a commit message: renamed getUser to fetchUser, updated 3 call sites.',
    fixtures: false,
    checks: [
      { type: 'conventional_header', target: 'commit_subject', types: ['feat', 'fix', 'refactor'], name: 'header' },
      { type: 'lowercase_initial', target: 'commit_subject', name: 'lowercase' },
      { type: 'length_less_than', target: 'commit_subject', limit: 72, name: 'length' },
    ],
  });
  assert.equal(source.uri, 'example.feature');
  assert.equal(source.line, 5);
  assert.equal(source.steps[0].line, 6);
  assert.equal(source.steps[1].phase, 'Outcome');
});

test('loadSuite attaches offline-only feature samples', () => {
  withSuite({ 'commit.feature': feature, 'commit.samples.json': samples }, (dir) => {
    const loaded = loadSuite(dir);
    assert.equal(loaded.length, 1);
    const c = loaded.find((candidate) => candidate.id === samples.caseId);
    assert.deepEqual(c.samples, { pass: samples.pass, fail: samples.fail });
    assert.ok(!c.prompt.includes(samples.pass[0]));
  });

});

test('fixture feature sample labels agree with the shared deterministic evaluator', () => {
  const [c] = loadSuite(fixtureDir);
  for (const text of c.samples.pass) assert.equal(gradeSample(c, text).passed, true, text);
  for (const text of c.samples.fail) assert.equal(gradeSample(c, text).passed, false, text);
});

test('controlled text, length, tables and named regex vocabulary emits neutral checks', () => {
  const [c] = compile(minimal(`Then the response contains "hello"
    And the response does not contain "bye"
    And the response starts with "hi"
    And the response is at most 100 characters
    And the response is shorter than 101 characters
    And the response contains each row:
      | first |
      | second |
    And the response matches regex named "pattern" with flags "im":
      """
      ^hello\\s+world$
      """
    And the response does not match regex named "not-pattern" with flags "":
      """
      forbidden
      """`));
  assert.deepEqual(c.checks.map((check) => check.type),
    ['contains', 'not_contains', 'starts_with', 'max_length', 'length_less_than', 'contains', 'contains', 'regex', 'not_regex']);
  assert.equal(c.checks[7].pattern, '^hello\\s+world$');
  assert.equal(c.checks[7].flags, 'im');
  assert.equal(c.checks[5].value, 'first');
  assert.equal(new Set(c.checks.map((check) => check.name)).size, c.checks.length);
});

test('semantic check IDs survive unrelated step insertion and source movement', () => {
  const [first] = compile(minimal());
  const [second] = compile(`\n${minimal('Then the response starts with "hi"\n    And the response contains "hello"')}`);
  assert.equal(first.checks[0].name, second.checks[1].name);
  assert.deepEqual(first.checks, compile(minimal())[0].checks);
});

const outline = (rows = '| first | alpha |\n      | second | beta |') => `Feature: Outlines
  @case:prompt-<id> @should-not-trigger
  Scenario Outline: Say <word>
    When the user asks:
      """
      Say <word>, not the expected answer.
      """
    Then the response contains "<word>"
    Examples:
      | id | word |
      ${rows}
`;

test('official compiler expands outlines with explicit row IDs before counts', () => {
  const expanded = compile(outline());
  assert.equal(expanded.length, 2);
  assert.deepEqual(expanded.map((c) => c.id), ['prompt-first', 'prompt-second']);
  assert.equal(expanded[0].prompt, 'Say alpha, not the expected answer.');
  assert.equal(expanded[0].checks[0].value, 'alpha');
  assert.equal(expanded[0].shouldTrigger, false);
  assert.equal(expanded[0].source.examples.line, 11);
  const reversed = compile(outline('| second | beta |\n      | first | alpha |'));
  assert.deepEqual(expanded.map(({ source, ...c }) => c).sort((a, b) => a.id.localeCompare(b.id)),
    reversed.map(({ source, ...c }) => c).sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(compile(outline().replace('@case:prompt-<id>', '@case:family')).map((c) => c.id), ['first', 'second']);
});

test('outline samples are attached per expanded case, not by outline row order', () => {
  withSuite({
    'outline.feature': outline(),
    'first.samples.json': sample('prompt-first'),
    'second.samples.json': sample('prompt-second'),
  }, (dir) => assert.equal(loadSuite(dir).length, 2));
});

test('Given fixture setup and setup-only Background compile to a boolean', () => {
  const source = minimal().replace('  @case:', '  Background:\n    Given the suite fixtures are available\n\n  @case:');
  assert.equal(compile(source)[0].fixtures, true);
  withSuite({ 'case.feature': source, 'case.samples.json': sample(), 'fixtures/readme.txt': 'context' },
    (dir) => assert.equal(loadSuite(dir)[0].fixtures, true));
  withSuite({ 'case.feature': source, 'case.samples.json': sample() },
    (dir) => assert.throws(() => loadSuite(dir), /fixture setup requires/));
});

test('fixture setup refuses arbitrary paths and an escaping fixture junction', () => {
  assert.throws(() => compile(minimal().replace('    When', '    Given fixtures "../private" are available\n    When')), /unknown step/);
  const source = minimal().replace('    When', '    Given the suite fixtures are available\n    When');
  withSuite({
    'case.feature': source,
    'case.samples.json': sample(),
    'fixtures/safe.txt': 'ok',
    'outside/not-approved.txt': 'private',
  }, (dir) => {
    symlinkSync(join(dir, 'outside'), join(dir, 'fixtures', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => loadSuite(dir), /escapes the approved/);
  });
});

for (const [name, source, message] of [
  ['unknown step', minimal('Then magic happens'), /unknown step/],
  ['wrong phase', minimal('Then the user asks:\n      """\n      another\n      """'), /belongs in Action/],
  ['phase regression', minimal('Then the response contains "hello"\n    Given the suite fixtures are available'), /phase order/],
  ['two prompts', minimal().replace('    Then', '    When the user asks:\n      """\n      another\n      """\n    Then'), /exactly one When/],
  ['no prompt', minimal().replace('    When the user asks:\n      """\n      Say hello.\n      """\n', ''), /preceding When/],
  ['empty prompt', minimal().replace('Say hello.', ''), /non-empty prompt/],
  ['missing checks', minimal(''), /Then check/],
  ['missing case tag', minimal(undefined, '@should-trigger'), /@case/],
  ['missing activation', minimal(undefined, '@case:hello'), /@should-trigger/],
  ['conflicting activation', minimal(undefined, '@case:hello @should-trigger @should-not-trigger'), /exactly one/],
  ['unknown tag', minimal(undefined, '@case:hello @should-trigger @skip'), /unsupported tag/],
  ['duplicate checks', minimal('Then the response contains "hello"\n    And the response contains "hello"'), /duplicate check/],
  ['duplicate named checks', minimal('Then the response contains "hello" named "same"\n    And the response contains "bye" named "same"'), /duplicate check/],
  ['invalid explicit check name', minimal('Then the response contains "hello" named "Bad_Name"'), /invalid check/],
  ['malformed regex', minimal('Then the response matches regex named "bad" with flags "":\n      """\n      [\n      """'), /invalid check/],
  ['invalid regex flags', minimal('Then the response matches regex named "bad" with flags "qq":\n      """\n      hello\n      """'), /invalid check/],
  ['empty conventional types', minimal('Then the commit subject uses a conventional header with types ""'), /invalid check/],
  ['duplicate conventional types', minimal('Then the commit subject uses a conventional header with types "feat,feat"'), /invalid check/],
  ['unexpected table', minimal('Then the response contains "hello"\n      | x |'), /no argument/],
  ['multi-column table', minimal('Then the response contains each row:\n      | x | y |'), /one-column/],
  ['missing Doc String', minimal().replace('      """\n      Say hello.\n      """\n', ''), /docString/],
  ['typed Doc String', minimal().replace('      """\n', '      """json\n'), /typed Doc Strings/],
  ['wildcard step', minimal().replace('    Then', '    *'), /unsupported keyword/],
  ['leading And', minimal().replace('    When', '    And'), /explicit phase/],
  ['action Background', minimal().replace('  @case:', '  Background:\n    When the user asks:\n      """\n      nope\n      """\n  @case:'), /setup-only/],
  ['outline missing id column', outline().replace('| id | word |', '| key | word |'), /id column/],
  ['outline invalid id', outline('| WRONG | word |'), /kebab-case/],
  ['outline duplicate id', outline('| same | alpha |\n      | same | beta |'), /duplicate case/],
  ['outline empty rows', outline(''), /at least one row/],
  ['outline no examples', outline().split('    Examples:')[0], /non-empty Examples/],
  ['non-English', '# language: fr\nFonctionnalité: f\n', /English/],
  ['Rule', 'Feature: f\n  Rule: r\n    Scenario: x\n', /Rule is unsupported/],
  ['malformed Gherkin', 'Feature: f\n  invalid structural syntax\n    """\n', /example.feature:/],
  ['no Feature', '', /Feature required/],
  ['no scenarios', 'Feature: f\n', /Scenario required/],
]) {
  test(`rejects ${name} offline with a source location`, () => {
    assert.throws(() => compile(source), (error) => {
      assert.match(error.message, /^example\.feature:\d+:\d+:/);
      assert.match(error.message, message);
      return true;
    });
  });
}

test('JSON case files are refused, alone or mixed with features', () => {
  const [json] = compile(minimal());
  for (const files of [{ 'case.json': json }, {
    'case.feature': minimal(), 'case.json': json, 'case.samples.json': sample(),
  }]) {
    withSuite(files, (dir) => assert.throws(() => loadSuite(dir), /case\.json:1:1: JSON case definitions are unsupported/));
  }
});

test('multiple feature files cannot declare the same stable ID', () => {
  withSuite({ 'first.feature': minimal(), 'second.feature': minimal(), 'case.samples.json': sample() },
    (dir) => assert.throws(() => loadSuite(dir), /duplicate case id hello/));
});

test('multiple scenarios may share feature activation and still require distinct case IDs', () => {
  const source = minimal().replace('Feature: Responses', '@should-trigger\nFeature: Responses').replace('@case:hello @should-trigger', '@case:hello');
  assert.equal(compile(source)[0].shouldTrigger, true);
  assert.throws(() => compile(minimal(undefined, '@case:hello @case:other @should-trigger')), /exactly one @case/);
});

test('literal whitespace and Unicode in prompt and text checks are not normalized', () => {
  const [c] = compile(minimal('Then the response contains "  😀 café  "').replace('Say hello.', '  hello 😀  '));
  assert.equal(c.prompt, '  hello 😀  ');
  assert.equal(c.checks[0].value, '  😀 café  ');
});

test('empty text values and signed length integers retain normalized contract semantics', () => {
  const [c] = compile(minimal('Then the response contains ""\n    And the response is at most -1 characters'));
  assert.equal(c.checks[0].value, '');
  assert.equal(c.checks[1].limit, -1);
  assert.equal(gradeSample(c, '').passed, false);
});

test('sample files reject missing, orphaned, duplicate, malformed and empty samples', () => {
  for (const [files, message] of [
    [{}, /requires a \*\.samples/],
    [{ 'orphan.samples.json': sample('orphan') }, /orphan samples/],
    [{ 'a.samples.json': sample(), 'b.samples.json': sample() }, /duplicate samples/],
    [{ 'a.samples.json': { ...sample(), pass: [] } }, /non-empty/],
    [{ 'a.samples.json': { ...sample(), fail: [42] } }, /non-empty/],
    [{ 'a.samples.json': { ...sample(), fail: [''] } }, /non-empty/],
    [{ 'a.samples.json': { ...sample(), extra: true } }, /samples must/],
    [{ 'a.samples.json': '{bad json' }, /JSON/],
  ]) {
    withSuite({ 'case.feature': minimal(), ...files }, (dir) => assert.throws(() => loadSuite(dir), message));
  }
});

test('no arbitrary suite size cap is introduced', () => {
  const rows = Array.from({ length: 101 }, (_, i) => `| case-${i} | hello |`).join('\n      ');
  assert.equal(compile(outline(rows)).length, 101);
});
