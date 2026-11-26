import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig, suiteInstructions, skillDependencyClosure, suiteSettings, validateSkillDependencies } from '../local/config.mjs';
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
  writeFileSync(p, JSON.stringify({ casesDir: 'cases', skillsRoots: ['../skills'], instructionFile: 'guidance.md', suites: { a: { skill: 'real-skill', cases: 'a-cases' } } }));
  const c = resolveConfig({ configPath: p, cwd });
  assert.equal(c.casesDir, join(dir, 'evals', 'cases'));
  assert.deepEqual(c.skillsRoots, [join(dir, 'skills')]);
  assert.equal(c.outputDir, join(dir, 'evals', '.work', 'local-runs'));
  assert.equal(c.instructionFile, join(dir, 'evals', 'guidance.md'));
  assert.deepEqual(suiteSettings(c, 'a'), { subject: 'skill', skill: 'real-skill', casesFolder: 'a-cases' });
  assert.deepEqual(suiteSettings(c, 'b'), { subject: 'skill', skill: 'b', casesFolder: 'b' });
  const o = resolveConfig({ configPath: p, cwd, flags: { outputDir: join(dir, 'out'), instructionFile: 'override.md' } });
  assert.equal(o.outputDir, join(dir, 'out'));
  assert.equal(o.instructionFile, join(cwd, 'override.md'));
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

test('skill dependencies resolve from config and default to none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-deps-'));
  try {
    const p = join(dir, 'evals.json');
    writeFileSync(p, JSON.stringify({ skillDependencies: { 'sprint-metrics': ['devops'] } }));
    assert.deepEqual(resolveConfig({ configPath: p, cwd }).skillDependencies, { 'sprint-metrics': ['devops'] });
    writeFileSync(p, JSON.stringify({}));
    assert.deepEqual(resolveConfig({ configPath: p, cwd }).skillDependencies, {});
    writeFileSync(p, JSON.stringify({ skillDependencies: { a: ['a'] } }));
    assert.throws(() => resolveConfig({ configPath: p, cwd }), /must not depend on itself/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skill dependency configuration rejects malformed values and cycles', () => {
  for (const [value, pattern] of [
    [[], /must be an object/],
    ['devops', /must be an object/],
    [{ a: 'b' }, /must be an array/],
    [{ a: [1] }, /kebab-case/],
    [{ a: ['Not-Kebab'] }, /kebab-case/],
    [{ 'Bad Name': ['b'] }, /kebab-case/],
    [{ a: ['b', 'b'] }, /more than once/],
    [{ a: ['a'] }, /must not depend on itself/],
    [{ a: ['b'], b: ['a'] }, /cycle: a -> b -> a/],
    [{ a: ['b'], b: ['c'], c: ['b'] }, /cycle: (a -> )?b -> c -> b/],
  ]) {
    assert.throws(() => validateSkillDependencies(value), pattern, JSON.stringify(value));
  }
  assert.deepEqual(validateSkillDependencies(undefined), {});
  assert.deepEqual(validateSkillDependencies({ a: [] }), { a: [] });
});

test('skill dependency closure is transitive, deduplicated and excludes the skill', () => {
  const dependencies = validateSkillDependencies({
    metrics: ['devops', 'conventions'], devops: ['conventions', 'auth'], conventions: [], constructor: ['auth'],
  });
  assert.deepEqual(skillDependencyClosure(dependencies, 'metrics'), ['devops', 'conventions', 'auth']);
  assert.deepEqual(skillDependencyClosure(dependencies, 'devops'), ['conventions', 'auth']);
  assert.deepEqual(skillDependencyClosure(dependencies, 'constructor'), ['auth']);
  assert.deepEqual(skillDependencyClosure(dependencies, 'unlisted'), []);
  assert.deepEqual(skillDependencyClosure({}, 'toString'), []);
  assert.throws(() => skillDependencyClosure({ a: ['b'], b: ['a'] }, 'a'), /cycle/);
});

test('compiled cases require schemaVersion 2 and named checks', () => {
  const ok = { schemaVersion: 2, id: 'x', prompt: 'p', shouldTrigger: false, checks: [{ name: 'answer', type: 'regex', pattern: 'a' }] };
  assert.deepEqual(validateCase(ok), []);
  for (const schemaVersion of [undefined, 1, 3]) {
    assert.ok(validateCase({ ...ok, schemaVersion }).length > 0);
  }
  assert.ok(validateCase({ ...ok, checks: [{ type: 'regex', pattern: 'a' }] }).length > 0);
});

test('instructions suites resolve candidate and baseline paths and validate their shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-instr-'));
  mkdirSync(join(dir, 'evals'));
  const p = join(dir, 'evals', 'evals.json');
  const write = (suites, extra = {}) => writeFileSync(p, JSON.stringify({ casesDir: 'cases', suites, ...extra }));
  write({ guide: { subject: 'instructions', instructions: '../AGENTS.md', baselineInstructions: '.work/baseline.md', cases: 'agents-md' }, plain: {} });
  const c = resolveConfig({ configPath: p, cwd });
  const settings = suiteSettings(c, 'guide');
  assert.deepEqual(settings, {
    subject: 'instructions', skill: null, casesFolder: 'agents-md',
    instructions: join(dir, 'AGENTS.md'), baselineInstructions: join(dir, 'evals', '.work', 'baseline.md'),
  });
  assert.deepEqual(suiteInstructions(c, settings), { candidate: join(dir, 'AGENTS.md'), baseline: join(dir, 'evals', '.work', 'baseline.md') });
  assert.equal(suiteSettings(c, 'plain').subject, 'skill');

  const flagged = resolveConfig({ configPath: p, cwd, flags: { instructionFile: 'cand.md', baselineInstructionFile: 'base.md' } });
  assert.deepEqual(suiteInstructions(flagged, suiteSettings(flagged, 'guide')), { candidate: join(cwd, 'cand.md'), baseline: join(cwd, 'base.md') });
  assert.throws(() => suiteInstructions(flagged, suiteSettings(flagged, 'plain')), /only supported by instructions suites/);

  write({ guide: { subject: 'instructions', instructions: 'a.md' } });
  assert.equal(suiteSettings(resolveConfig({ configPath: p, cwd }), 'guide').baselineInstructions, null);
  write({ guide: { subject: 'instructions', instructions: 'a.md' } }, { instructionFile: 'env.md' });
  const ambiguous = resolveConfig({ configPath: p, cwd });
  assert.throws(() => suiteInstructions(ambiguous, suiteSettings(ambiguous, 'guide')), /ambiguous/);

  for (const [suites, pattern] of [
    [{ g: { subject: 'instructions' } }, /requires an "instructions" path/],
    [{ g: { subject: 'instructions', instructions: 'a.md', skill: 'x' } }, /does not name a skill/],
    [{ g: { subject: 'instructions', instructions: 'a.md', baselineInstructions: 3 } }, /path or null/],
    [{ g: { instructions: 'a.md' } }, /require "subject": "instructions"/],
    [{ g: { subject: 'rules' } }, /subject must be one of/],
  ]) {
    write(suites);
    assert.throws(() => resolveConfig({ configPath: p, cwd }), pattern);
  }
});
