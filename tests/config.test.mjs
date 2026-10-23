import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig, suiteSettings } from '../local/config.mjs';
import { validateCase } from '../local/contract.mjs';

const cwd = resolve(import.meta.dirname, '..');

test('defaults belong to the caller, not the engine installation', () => {
  const c = resolveConfig({ cwd });
  assert.equal(c.casesDir, join(cwd, 'evals', 'cases'));
  assert.equal(c.outputDir, join(cwd, 'evals', '.work', 'local-runs'));
  assert.equal(c.resultsDir, join(cwd, 'evals', '.work', 'results'));
  assert.equal(c.skillsRoots[0], join(cwd, 'skills'));
});

test('config paths resolve relative to the config file and flags override them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(dir, 'evals'));
  const p = join(dir, 'evals', 'evals.json');
  writeFileSync(p, JSON.stringify({ casesDir: 'cases', skillsRoots: ['../skills'], suites: { a: { skill: 'real-skill', cases: 'a-cases' } } }));
  const c = resolveConfig({ configPath: p, cwd });
  assert.equal(c.casesDir, join(dir, 'evals', 'cases'));
  assert.deepEqual(c.skillsRoots, [join(dir, 'skills')]);
  assert.equal(c.outputDir, join(dir, 'evals', '.work', 'local-runs'));
  assert.deepEqual(suiteSettings(c, 'a'), { skill: 'real-skill', casesFolder: 'a-cases' });
  assert.deepEqual(suiteSettings(c, 'b'), { skill: 'b', casesFolder: 'b' });
  const o = resolveConfig({ configPath: p, cwd, flags: { outputDir: join(dir, 'out') } });
  assert.equal(o.outputDir, join(dir, 'out'));
  assert.throws(() => resolveConfig({ configPath: join(dir, 'missing.json'), cwd }));
});

test('discovers evals/evals.json from nested working directories', () => {
  const root = join(import.meta.dirname, 'fixtures', `.config-discovery-${process.pid}`);
  const nested = join(root, 'packages', 'app');
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, 'evals'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'evals', 'evals.json'), JSON.stringify({ casesDir: 'cases' }));
    const discovered = resolveConfig({ cwd: nested });
    assert.equal(discovered.casesDir, join(root, 'evals', 'cases'));
    const explicit = resolveConfig({ cwd: nested, configPath: join(cwd, 'tests', 'fixtures', 'evals.json') });
    assert.equal(explicit.casesDir, join(cwd, 'tests', 'fixtures', 'cases'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schemaVersion is optional but must be supported', () => {
  const ok = { id: 'x', prompt: 'p', shouldTrigger: false, checks: [{ type: 'regex', pattern: 'a' }] };
  assert.deepEqual(validateCase(ok), []);
  assert.deepEqual(validateCase({ ...ok, schemaVersion: 1 }), []);
  assert.ok(validateCase({ ...ok, schemaVersion: 2 }).length > 0);
});
