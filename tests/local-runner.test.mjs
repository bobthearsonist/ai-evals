import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerRunner, validateCase, gradeSample } from '../local/contract.mjs';
import { compileClaudePlugin, loadSuite } from '../local/compile-claude.mjs';
import { buildArgs, normalizeAggregate, plannedSessions, versionAtLeast, isCompleteRun } from '../local/claude-plugin-eval.mjs';
import { registerStubs } from '../local/stubs.mjs';
import { getRunner } from '../local/contract.mjs';

const suiteDir = fileURLToPath(new URL('./fixtures/cases/demo', import.meta.url));
const configPath = fileURLToPath(new URL('./fixtures/evals.json', import.meta.url));
const cli = fileURLToPath(new URL('../local/cli.mjs', import.meta.url));

test('cases load and validate', () => {
  assert.equal(loadSuite(suiteDir).length, 3);
  assert.ok(validateCase({}).length > 0);
});

test('registry rejects hermetic claims', () => {
  assert.throws(() => registerRunner({ id: 'x', run() {}, preflight() {}, capabilities: { hermetic: true } }));
});

test('stubs report not implemented', async () => {
  registerStubs();
  const r = await getRunner('copilot').run();
  assert.equal(r.status, 'not_implemented');
});

test('session math and version gate', () => {
  assert.equal(plannedSessions({ caseCount: 3, runs: 3, ablation: 'with-without' }), 18);
  assert.equal(plannedSessions({ caseCount: 1, runs: 1, ablation: 'none' }), 1);
  assert.ok(versionAtLeast([2, 1, 301]));
  assert.ok(!versionAtLeast([2, 1, 268]));
});

test('args are serial, unpublished, capped', () => {
  const a = buildArgs({ pluginRoot: 'p', outputDir: 'o', runs: 3, ablation: 'with-without', maxCostUsd: 5 });
  assert.deepEqual(a.slice(a.indexOf('-j'), a.indexOf('-j') + 2), ['-j', '1']);
  for (const f of ['--no-publish', '--max-cost-usd']) assert.ok(a.includes(f));
  assert.ok(!a.includes('--bare'));
});

test('aggregate normalization', () => {
  const n = normalizeAggregate({ aggregates: { overallScore: 0.9 }, claudeVersion: '2.1.301', cases: [{ id: 'a', aggregates: { score: 1, delta: 0.2 } }] });
  assert.equal(n.cases[0].delta, 0.2);
  assert.equal(n.overallScore, 0.9);
});

test('compile emits plugin, graders, no shell tools', () => {
  const out = mkdtempSync(join(tmpdir(), 'cc-'));
  const skill = join(out, 'src');
  fsSync.mkdirSync(skill);
  fsSync.writeFileSync(join(skill, 'SKILL.md'), '---\nname: x\n---\n');
  const r = compileClaudePlugin({ outDir: out, skillName: 'x', skillSourceDir: skill, cases: loadSuite(suiteDir) });
  assert.ok(existsSync(join(r.pluginRoot, '.claude-plugin', 'plugin.json')));
  const prompt = readFileSync(join(r.pluginRoot, 'evals', 'negative-control', 'prompt.md'), 'utf8');
  assert.match(prompt, /allowed_tools: \[Skill\]/);
  assert.doesNotMatch(prompt, /Bash|Write|Edit/);
  assert.match(readFileSync(join(r.pluginRoot, 'evals', 'negative-control', 'graders', '90-skill-trigger.md'), 'utf8'), /max: 0/);
});

test('file_exists and tool_order checks compile', () => {
  const out = mkdtempSync(join(tmpdir(), 'cc-'));
  const skill = join(out, 'src');
  fsSync.mkdirSync(skill);
  fsSync.writeFileSync(join(skill, 'SKILL.md'), '---\nname: x\n---\n');
  const cases = [{ id: 'c', prompt: 'p', shouldTrigger: true, checks: [
    { type: 'file_exists', name: 'out', path: 'out.md' },
    { type: 'tool_order', name: 'order', before: 'Read', after: 'Edit' }] }];
  assert.deepEqual(validateCase(cases[0]), []);
  const r = compileClaudePlugin({ outDir: out, skillName: 'x', skillSourceDir: skill, cases });
  assert.match(readFileSync(join(r.pluginRoot, 'evals', 'c', 'graders', '01-out.md'), 'utf8'), /type: file_exists/);
  assert.match(readFileSync(join(r.pluginRoot, 'evals', 'c', 'graders', '02-order.md'), 'utf8'), /before: "Read"/);
  assert.equal(readFileSync(join(out, 'canary.txt'), 'utf8'), r.canaryToken);
});

test('approval gate blocks without --approve-sessions', () => {
  const r = spawnSync(process.execPath, [cli, 'run', '--config', configPath, '--suite', 'demo', '--exe', process.execPath], { encoding: 'utf8' });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /--approve-sessions 18/);
});


test('graders classify synthetic samples as declared', () => {
  const root = fileURLToPath(new URL('./fixtures/cases', import.meta.url));
  let checked = 0;
  for (const s of fsSync.readdirSync(root)) {
    for (const c of loadSuite(join(root, s))) {
      for (const text of c.samples?.pass ?? []) {
        const r = gradeSample(c, text);
        assert.ok(r.passed, `${s}/${c.id} should pass: ${JSON.stringify(text)} failed ${r.failed}`);
        checked++;
      }
      for (const text of c.samples?.fail ?? []) {
        assert.ok(!gradeSample(c, text).passed, `${s}/${c.id} should fail: ${JSON.stringify(text)}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 6);
});

test('runs that never produced a result are excluded from scores', () => {
  const files = { good: '{"type":"assistant"}\n{"duration_api_ms":1,"type":"result"}\n', bad: '{"type":"assistant"}\n' };
  const io = { exists: () => true, read: (p) => files[p] };
  assert.equal(isCompleteRun({ tracePath: 'good' }, io), true);
  assert.equal(isCompleteRun({ tracePath: 'bad' }, io), false);
  const n = normalizeAggregate({ cases: [{ name: 'a', arms: { with: [{ score: 1, tracePath: join(tmpdir(), 'nope-trace.jsonl') }, { score: 0 }], without: [{ score: 0.5 }] } }] });
  assert.equal(n.cases[0].invalidRuns, 0);
});
