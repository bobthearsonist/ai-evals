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
import { buildArgs, normalizeAggregate, plannedSessions, versionAtLeast, isCompleteRun, isBlockedFromInputs } from '../local/claude-plugin-eval.mjs';
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
  const r = await getRunner('opencode').run();
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

test('grader labels produce bounded portable filenames, not paths', () => {
  const out = mkdtempSync(join(tmpdir(), 'cc-label-'));
  try {
    const skill = join(out, 'src');
    fsSync.mkdirSync(skill);
    fsSync.writeFileSync(join(skill, 'SKILL.md'), '---\nname: x\n---\n');
    const labels = ['read/write', '..\\outside/label', 'a:b*?"<>|', 'x'.repeat(512), '///', 'same', 'same'];
    const cases = [{ id: 'labels', prompt: 'p', shouldTrigger: true,
      checks: labels.map((name) => ({ type: 'regex', name, pattern: 'answer' })) }];
    const { pluginRoot } = compileClaudePlugin({ outDir: out, skillName: 'x', skillSourceDir: skill, cases });
    const dir = join(pluginRoot, 'evals', 'labels', 'graders');
    const names = fsSync.readdirSync(dir);
    assert.equal(names.length, labels.length + 2);
    for (const name of names) {
      assert.match(name, /^\d+-[a-zA-Z0-9_-]+\.md$/);
      assert.ok(name.length <= 70);
      assert.ok(fsSync.statSync(join(dir, name)).isFile());
    }
    assert.match(readFileSync(join(dir, '01-read-write.md'), 'utf8'), /pattern: "answer"/);
  } finally {
    fsSync.rmSync(out, { recursive: true, force: true });
  }
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

test('fixture runs refused every file read are excluded; other runs stay scored', () => {
  const call = (id, name) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const reply = (id, text, isError) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  const denial = "Permission to use Read has been denied because Claude Code is running in don't ask mode.";
  const done = '{"type":"result"}';
  const traces = {
    blocked: [call('r1', 'Read'), reply('r1', denial, true), call('g1', 'Glob'), reply('g1', denial, true), done].join('\n'),
    recovered: [call('g1', 'Glob'), reply('g1', denial, true), call('r1', 'Read'), reply('r1', 'fixture text', false), done].join('\n'),
    unread: done,
  };
  const io = { exists: () => true, read: (p) => traces[p] };
  assert.equal(isBlockedFromInputs({ tracePath: 'blocked' }, io), true);
  assert.equal(isBlockedFromInputs({ tracePath: 'recovered' }, io), false);
  assert.equal(isBlockedFromInputs({ tracePath: 'unread' }, io), false);
  const root = join(import.meta.dirname, '..', '.work');
  fsSync.mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'blocked-'));
  try {
    for (const [k, v] of Object.entries(traces)) fsSync.writeFileSync(join(dir, `${k}.jsonl`), v);
    const agg = { cases: [{ name: 'fx', arms: {
      with: [{ score: 0, tracePath: join(dir, 'blocked.jsonl') }, { score: 1, tracePath: join(dir, 'recovered.jsonl') }],
      without: [{ score: 0, tracePath: join(dir, 'unread.jsonl') }],
    } }] };
    const fixtureRun = normalizeAggregate(agg, { fixtureCaseIds: new Set(['fx']) }).cases[0];
    assert.equal(fixtureRun.invalidRuns, 1);
    assert.deepEqual(fixtureRun.withRuns, [1]);
    assert.equal(normalizeAggregate(agg).cases[0].invalidRuns, 0);
  } finally { fsSync.rmSync(dir, { recursive: true, force: true }); }
});
