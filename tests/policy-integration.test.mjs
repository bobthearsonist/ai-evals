import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archivePolicy, archiveReplay, policySnapshot, replayPolicy } from '../local/policy.mjs';
import { createAcpRunner } from '../local/acp-runner.mjs';

const definition = {
  schemaVersion: 2, id: 'greeting', prompt: 'Say hello.', shouldTrigger: false,
  checks: [{ type: 'contains', name: 'greeting', value: 'hello' }],
};
const trace = (answer) => JSON.stringify({
  type: 'ai-evals.acp', schemaVersion: 1,
  transcript: { finalText: answer, toolCalls: [], raw: answer, complete: true },
});
const temporary = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'eval-policy-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('policy is immutable, samples stay out, current replay is explicit', () => temporary((root) => {
  const saved = archivePolicy(root, [{ ...definition, samples: { pass: ['secret sample'] } }], { plannedSessions: 1 });
  assert.doesNotMatch(readFileSync(join(root, 'policy.json'), 'utf8'), /secret sample/);
  assert.throws(() => archivePolicy(root, [definition], {}), /EEXIST/);
  const current = [{ ...definition, checks: [{ type: 'contains', value: 'goodbye' }] }];
  assert.equal(replayPolicy(root, { currentCases: current }).sha256, saved.sha256);
  const policy = replayPolicy(root, { currentCases: current, mode: 'current' });
  assert.notEqual(policy.sha256, saved.sha256);
  const first = archiveReplay(root, policy, []);
  const second = archiveReplay(root, policy, []);
  assert.notEqual(first, second);
  assert.equal(JSON.parse(readFileSync(first)).policyMode, 'current');
  writeFileSync(join(root, 'policy.json'), JSON.stringify({ ...saved, sha256: 'modified' }));
  assert.throws(() => replayPolicy(root), /hash does not match/);
}));

test('legacy archives require deliberate current-policy replay', () => temporary((root) => {
  assert.throws(() => replayPolicy(root, { currentCases: [definition] }), /--policy current/);
  assert.equal(replayPolicy(root, { currentCases: [definition], mode: 'current' }).sha256, policySnapshot([definition]).sha256);
}));

test('offline CLI validation and dry run never probe the native executable', () => {
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const config = resolve(import.meta.dirname, 'fixtures/evals.json');
  for (const command of ['validate', 'run']) {
    const proc = spawnSync(process.execPath, [cli, command, '--config', config, '--suite', 'demo',
      '--exe', 'must-not-launch', '--json', ...(command === 'run' ? ['--dry-run'] : [])], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    const result = JSON.parse(proc.stdout);
    assert.equal(command === 'run' ? result.plannedSessions : result.caseCount, command === 'run' ? 18 : 3);
  }
});

test('recorded CLI replay works after the source suite is gone and keeps original scores', () => temporary((root) => {
  archivePolicy(root, [definition], { plannedSessions: 1 });
  writeFileSync(join(root, 'normalized.json'), JSON.stringify({ client: 'claude', transport: 'acp', overallScore: 1 }));
  const dir = join(root, 'traces', definition.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'with-1.jsonl'), trace('hello'));
  writeFileSync(join(dir, 'with-1.jsonl.receipt.json'), JSON.stringify({ valid: true, exitCode: 0 }));
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'regrade', root], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /policy=recorded/);
  assert.match(result.stdout, /greeting: with=1\.00/);
  assert.equal(JSON.parse(readFileSync(join(root, 'normalized.json'))).overallScore, 1);
}));

test('expanded outline approval is computed before probing any executable', () => temporary((root) => {
  const casesDir = join(root, 'cases', 'outline');
  const skills = join(root, 'skills', 'outline');
  mkdirSync(casesDir, { recursive: true });
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: outline\n---\nGreet.\n');
  writeFileSync(join(root, 'evals.json'), JSON.stringify({ casesDir: 'cases', skillsRoots: ['skills'] }));
  writeFileSync(join(casesDir, 'outline.feature'), `Feature: Expanded approval
  @case:greeting-<id> @should-not-trigger
  Scenario Outline: A greeting
    When the user asks:
      """
      Say <word>.
      """
    Then the response contains "<word>"
    Examples:
      | id  | word  |
      | one | hello |
      | two | hi    |
`);
  for (const [id, word] of [['one', 'hello'], ['two', 'hi']]) {
    writeFileSync(join(casesDir, `${id}.samples.json`), JSON.stringify({
      caseId: `greeting-${id}`, pass: [word], fail: ['goodbye'],
    }));
  }
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const proc = spawnSync(process.execPath, [cli, 'run', '--config', join(root, 'evals.json'),
    '--suite', 'outline', '--client', 'copilot', '--exe', 'must-not-launch'], { encoding: 'utf8' });
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, /--approve-sessions 12/);
}));

test('unsupported v2 filesystem evidence is refused before any selected suite runs', () => temporary((root) => {
  const dir = join(root, 'cases', 'unsupported');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify({
    ...definition, checks: [{ name: 'result-file', type: 'file_exists', path: 'result.txt' }],
  }));
  const config = join(root, 'evals.json');
  writeFileSync(config, JSON.stringify({ casesDir: 'cases' }));
  const cli = resolve(import.meta.dirname, '../local/cli.mjs');
  const proc = spawnSync(process.execPath, [cli, 'run-all', '--config', config,
    '--approve-sessions', '6', '--exe', 'must-not-launch'], { encoding: 'utf8' });
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /unsupported execution evidence/);
  assert.doesNotMatch(proc.stderr, /not runnable|ENOENT/);
}));

test('direct Claude runner API also rejects unsupported evidence before spawning', async () => {
  const runner = createAcpRunner({ client: 'claude', exe: 'must-not-launch' });
  await assert.rejects(runner.run([{
    ...definition, checks: [{ name: 'result-file', type: 'file_exists', path: 'result.txt' }],
  }], { runs: 1, ablation: 'none' }), /unsupported ACP execution evidence/);
});
