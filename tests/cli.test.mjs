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

test('CLI requires an explicit suite and keeps Copilot stubbed', () => {
  assert.equal(run(['run']).status, 64);
  const r = run(['run', '--client', 'copilot']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /copilot: not implemented/);
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
  const r = run(['run-all', '--config', cfg, '--approve-sessions', '18', '--client', 'copilot'], cwd);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /copilot: not implemented/);
  assert.match(r.stdout, /demo: error/);
  const summary = readFileSync(join(cwd, '.work', 'results', 'summary.md'), 'utf8');
  assert.doesNotMatch(summary, /\| demo \|/);
});
