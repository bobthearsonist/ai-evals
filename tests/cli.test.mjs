import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve(import.meta.dirname, '../local/cli.mjs');
const fixtures = resolve(import.meta.dirname, 'fixtures');
const config = join(fixtures, 'evals.json');
const run = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });

test('installed CLI can show help without skills or Claude', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ai-evals-help-'));
  const r = run(['--help'], cwd);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ai-evals/);
});

test('CLI requires an explicit suite and keeps OpenCode stubbed', () => {
  assert.equal(run(['run']).status, 64);
  const r = run(['run', '--client', 'opencode']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /opencode: not implemented/);
});

test('run-all discovers caller config suites and computes approval count', () => {
  const r = run(['run-all', '--config', config]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /18 live session\(s\) across 1 suites/);
  const unknown = run(['run-all', '--config', config, '--suites', 'missing']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown or empty suite/);
});

test('run-all surfaces child errors and cannot report success from stale history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ai-evals-all-'));
  const cfg = join(cwd, 'evals.json');
  writeFileSync(cfg, JSON.stringify({
    casesDir: join(fixtures, 'cases'),
    skillsRoots: [join(fixtures, 'skills')],
  }));
  const r = run(['run-all', '--config', cfg, '--approve-sessions', '18', '--exe', join(cwd, 'missing-cli')], cwd);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /preflight failed/);
  assert.match(r.stdout, /preflight: error client=claude/);
  const summary = readFileSync(join(cwd, '.work', 'results', 'summary.md'), 'utf8');
  assert.doesNotMatch(summary, /\| demo \|/);
});

test('Copilot requires approval before probing its executable, including run-all', () => {
  const all = run(['run-all', '--config', config, '--client', 'copilot']);
  assert.equal(all.status, 1);
  assert.match(all.stdout, /--approve-sessions 18/);
  const one = run(['run', '--config', config, '--suite', 'demo', '--client', 'copilot', '--model', 'test-model', '--exe', 'must-not-be-launched']);
  assert.equal(one.status, 4);
  assert.match(one.stderr, /--approve-sessions 18/);
});

test('runner selection supports comma lists and repetition with total approvals', () => {
  for (const args of [['--runners', 'claude,copilot'], ['--runners', 'claude', '--runners', 'copilot']]) {
    const all = run(['run-all', '--config', config, ...args, '--copilot-model', 'test-model']);
    assert.equal(all.status, 1);
    assert.match(all.stdout, /36 live session\(s\) across 1 suites and 2 runner\(s\)/);
    const smoke = run(['smoke', '--suite', 'demo', '--config', config, ...args]);
    assert.equal(smoke.status, 1);
    assert.match(smoke.stdout, /--approve-sessions 2/);
    const one = run(['run', '--suite', 'demo', '--case', 'explicit-positive', '--runs', '1', '--config', config, ...args]);
    assert.equal(one.status, 1);
    assert.match(one.stdout, /--approve-sessions 4/);
  }
});

test('runner selection rejects unsupported, duplicate or ambiguous options before probing', () => {
  for (const [args, pattern] of [
    [['--runners', 'claude,claude'], /distinct/],
    [['--runners', 'copilot,'], /non-empty/],
    [['--runners', 'missing'], /unknown client/],
    [['--runners', 'claude,opencode'], /opencode: not implemented/],
    [['--runners', 'claude,copilot', '--exe', 'must-not-launch'], /ambiguous/],
    [['--runners', 'claude,copilot', '--model', 'x'], /ambiguous/],
    [['--runners', 'copilot', '--client', 'claude'], /either --client or --runners/],
  ]) {
    const r = run(['run-all', '--config', config, ...args]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, pattern);
  }
});

test('multi-runner preflight failure prevents all paid jobs and reports every client', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ai-evals-multi-'));
  const r = run([
    'smoke', '--config', config, '--suite', 'demo', '--runners', 'claude,copilot',
    '--copilot-model', 'test-model', '--approve-sessions', '2',
    '--claude-exe', join(cwd, 'missing-claude'), '--copilot-exe', join(cwd, 'missing-copilot'),
    '--results-dir', join(cwd, 'results'),
  ], cwd);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /preflight: error client=claude/);
  assert.match(r.stdout, /preflight: error client=copilot/);
  assert.doesNotMatch(r.stdout, /demo: passed/);
});
