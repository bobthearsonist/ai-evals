import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeSample, registerRunner, validateCase } from '../local/contract.mjs';
import { loadSuite } from '../local/suite.mjs';
import { hashTree, plannedSessions, prepareWorkspace } from '../local/workspace.mjs';

const suiteDir = join(import.meta.dirname, 'fixtures', 'cases', 'demo');

test('cases validate and synthetic samples keep their declared classifications', () => {
  const cases = loadSuite(suiteDir);
  assert.equal(cases.length, 3);
  assert.ok(validateCase({}).length > 0);
  let checked = 0;
  for (const c of cases) {
    for (const text of c.samples?.pass ?? []) {
      assert.equal(gradeSample(c, text).passed, true, `${c.id}: ${text}`);
      checked++;
    }
    for (const text of c.samples?.fail ?? []) {
      assert.equal(gradeSample(c, text).passed, false, `${c.id}: ${text}`);
      checked++;
    }
  }
  assert.ok(checked >= 6);
});

test('registry rejects hermetic claims and session math covers both schedules', () => {
  assert.throws(() => registerRunner({ id: 'x', run() {}, preflight() {}, capabilities: { hermetic: true } }));
  assert.equal(plannedSessions({ caseCount: 3, runs: 3, ablation: 'with-without' }), 18);
  assert.equal(plannedSessions({ caseCount: 1, runs: 1, ablation: 'none' }), 1);
});

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const fixtures = join(root, 'inputs');
  mkdirSync(source);
  mkdirSync(fixtures);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nSay hello.\n');
  writeFileSync(join(fixtures, 'input.txt'), 'fixture');
  return { root, source, fixtures, options: {
    outDir: join(root, 'prepared'), skillName: 'demo', skillSourceDir: source, fixturesDir: fixtures,
    cases: [{ schemaVersion: 2, id: 'greeting', prompt: 'Read {{fixtures}}', fixtures: true, shouldTrigger: false,
      checks: [{ name: 'greeting', type: 'regex', pattern: 'hello' }] }],
  } };
}

test('workspace snapshots preserve source bytes and hash and keep the canary outside inputs', (t) => {
  const { root, source, options } = setup(t);
  const prepared = prepareWorkspace(options);
  assert.equal(readFileSync(join(prepared.skillSnapshot, 'SKILL.md'), 'utf8'), readFileSync(join(source, 'SKILL.md'), 'utf8'));
  assert.equal(prepared.skillHash, hashTree(source));
  assert.equal(readFileSync(join(prepared.fixtureSnapshot, 'input.txt'), 'utf8'), 'fixture');
  assert.equal(readFileSync(join(root, 'prepared', 'canary.txt'), 'utf8'), prepared.canaryToken);
  assert.equal(existsSync(join(prepared.skillSnapshot, 'canary.txt')), false);
  assert.match(prepared.canaryToken, /^[a-f0-9]{48}$/);
  const noFixtures = prepareWorkspace({ ...options, outDir: join(root, 'without-fixtures'), fixturesDir: null,
    cases: options.cases.map((c) => ({ ...c, fixtures: false })) });
  assert.equal(noFixtures.fixtureSnapshot, null);
});

test('workspace rejects invalid cases, missing fixtures and unsupported filesystem checks', (t) => {
  const { options } = setup(t);
  assert.throws(() => prepareWorkspace({ ...options, skillName: '../bad' }), /kebab-case/);
  assert.throws(() => prepareWorkspace({ ...options, cases: [{}] }), /invalid|id|prompt/);
  assert.throws(() => prepareWorkspace({ ...options, fixturesDir: null }), /fixtures directory/);
  assert.throws(() => prepareWorkspace({ ...options, cases: [{
    ...options.cases[0], checks: [{ name: 'result-file', type: 'file_exists', path: 'result.txt' }],
  }] }), /does not support file_exists/);
});

test('workspace rejects links in either skill or fixture payloads', (t) => {
  const { source, fixtures, options } = setup(t);
  // Windows directory junctions do not require symlink privileges.
  const link = (dir) => symlinkSync(fixtures, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  link(source);
  assert.throws(() => prepareWorkspace(options), /symlink/);
  rmSync(join(source, 'linked'));
  symlinkSync(source, join(fixtures, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareWorkspace(options), /symlink/);
});
