import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeSample, registerRunner, validateCase } from '../local/contract.mjs';
import { loadSuite } from '../local/suite.mjs';
import { hashTree, plannedSessions, prepareWorkspace } from '../local/workspace.mjs';
import { removeTemporaryDirectory } from '../local/cleanup.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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

test('skill dependencies are snapshotted beside the skill under test with their own hashes', (t) => {
  const { root, options } = setup(t);
  const helper = join(root, 'helper');
  mkdirSync(join(helper, 'references'), { recursive: true });
  writeFileSync(join(helper, 'SKILL.md'), '---\nname: helper\n---\nHelp.\n');
  writeFileSync(join(helper, 'references', 'conventions.md'), 'conventions');
  const prepared = prepareWorkspace({ ...options, dependencies: [{ name: 'helper', sourceDir: helper }] });
  assert.deepEqual(prepared.dependencies.map(({ name }) => name), ['helper']);
  assert.equal(prepared.dependencies[0].snapshot, join(root, 'prepared', 'skill-source', 'helper'));
  assert.equal(readFileSync(join(prepared.dependencies[0].snapshot, 'references', 'conventions.md'), 'utf8'), 'conventions');
  assert.equal(prepared.dependencies[0].sha256, hashTree(helper));
  assert.equal(prepared.skillHash, hashTree(options.skillSourceDir), 'the skill hash still covers only the skill under test');
  assert.deepEqual(prepareWorkspace({ ...options, outDir: join(root, 'no-deps') }).dependencies, []);
  for (const [dependencies, pattern] of [
    [[{ name: 'demo', sourceDir: helper }], /own dependency/],
    [[{ name: 'helper', sourceDir: helper }, { name: 'helper', sourceDir: helper }], /distinct/],
    [[{ name: '../escape', sourceDir: helper }], /kebab-case/],
  ]) {
    assert.throws(() => prepareWorkspace({ ...options, outDir: join(root, 'rejected'), dependencies }), pattern);
  }
  symlinkSync(options.fixturesDir, join(helper, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareWorkspace({ ...options, outDir: join(root, 'linked'), dependencies: [{ name: 'helper', sourceDir: helper }] }), /symlink/);
});

test('explicit instructions are snapshotted and hashed, and symlinks are refused', (t) => {
  const { root, options } = setup(t);
  const instructionFile = join(root, 'instructions.md');
  writeFileSync(instructionFile, 'guidance\n');
  const prepared = prepareWorkspace({ ...options, instructionFile });
  assert.equal(readFileSync(prepared.instructionSnapshot, 'utf8'), 'guidance\n');
  assert.equal(prepared.instructionHash, createHash('sha256').update('guidance\n').digest('hex'));
  const link = join(root, 'linked.md');
  if (process.platform !== 'win32') {
    symlinkSync(instructionFile, link);
    assert.throws(() => prepareWorkspace({ ...options, outDir: join(root, 'linked-output'), instructionFile: link }), /regular file/);
  }
});

test('temporary directory removal retries transient errors with bounded backoff', () => {
  const calls = [];
  const sleeps = [];
  removeTemporaryDirectory('temporary-path', {
    remove(path, options) {
      calls.push({ path, options });
      if (calls.length < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { path: 'temporary-path', options: { recursive: true, force: true } });
  assert.deepEqual(sleeps, [200, 400]);
});

test('temporary directory removal stops on non-retryable or exhausted errors', () => {
  for (const [code, expectedAttempts] of [['EACCES', 1], ['EBUSY', 9]]) {
    let attempts = 0;
    const sleeps = [];
    const error = Object.assign(new Error(code), { code });
    assert.throws(() => removeTemporaryDirectory('temporary-path', {
      remove() { attempts++; throw error; },
      sleep: (ms) => sleeps.push(ms),
    }), (caught) => caught === error);
    assert.equal(attempts, expectedAttempts);
    assert.equal(sleeps.length, expectedAttempts - 1);
  }
});

test('temporary directory removal waits for a Windows process to release its working directory',
  { skip: process.platform !== 'win32' }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'acp-cleanup-'));
    const child = spawn(process.execPath, ['-e',
      "process.stdout.write('ready'); setTimeout(() => process.exit(0), 1000);",
    ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    });
    await once(child.stdout, 'data');
    assert.throws(() => rmSync(root, { recursive: true, force: true }), { code: 'EBUSY' });
    removeTemporaryDirectory(root);
    assert.equal(existsSync(root), false);
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
