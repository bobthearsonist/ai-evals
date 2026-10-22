import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditSkills, buildCopilotArgs, createLegacyCopilotRunner as createCopilotRunner, parseCopilotTrace, prepareCopilot } from '../local/copilot.mjs';
import { regradeRun } from '../local/regrade.mjs';
import { historyRoot, loadLatest, recordRun } from '../local/summary.mjs';

const event = (type, data = {}, extra = {}) => JSON.stringify({ type, data, ...extra });
const trace = (...events) => events.join('\n') + '\n';
const message = (content = 'hello') => event('assistant.message', { content });
const idle = () => event('session.idle');
const fake = resolve(import.meta.dirname, 'fixtures', 'fake-copilot.mjs');
const cli = resolve(import.meta.dirname, '..', 'local', 'cli.mjs');
const fixtureConfig = resolve(import.meta.dirname, 'fixtures', 'evals.json');

function setup(t, mode = '', extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(source);
  mkdirSync(fixtures);
  const content = '---\nname: demo\ndescription: synthetic greeting\n---\nSay hello.\n';
  writeFileSync(join(source, 'SKILL.md'), content);
  writeFileSync(join(fixtures, 'input.txt'), 'fixture only');
  const cases = [{ id: 'greeting', prompt: '[invoke] Inspect {{fixtures}}', fixtures: true, shouldTrigger: true, checks: [{ type: 'regex', pattern: 'hello' }] }];
  const out = join(dir, 'run');
  const prepared = prepareCopilot({ outDir: out, skillName: 'demo', skillSourceDir: source, fixturesDir: fixtures, cases });
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/TOKEN|API_KEY|AUTH_TOKEN|BASE_URL|COPILOT_PROVIDER|COPILOT_ALLOW_ALL|COPILOT_ASSISTED_APPROVAL/i.test(k)) delete env[k];
  }
  const log = join(dir, 'processes.jsonl');
  const runner = createCopilotRunner({ transport: 'cli', exe: process.execPath, prefixArgs: [fake], env: { ...env, FAKE_COPILOT_MODE: mode, FAKE_COPILOT_LOG: log, ...extraEnv } });
  const opts = { ...prepared, outputDir: join(out, 'eval-output'), model: 'synthetic-model', runs: 1, ablation: 'with-without', concurrency: 1 };
  return { dir, source, fixtures, content, cases, out, runner, opts, log };
}

test('Copilot parser preserves raw, ordered tools, and actual skill invocation evidence', () => {
  const text = trace(
    event('session.start'),
    event('tool.execution_start', { toolName: 'skill', arguments: { skill: 'demo' } }),
    event('skill.invoked', { name: 'demo', path: 'SKILL.md' }),
    event('tool.execution_start', { toolName: 'view', arguments: { path: 'input.txt' } }),
    event('tool.execution_start', { toolName: 'rg', arguments: {} }),
    message(), event('future.additive.event', { newField: true }), '{"type":"future.other","payload":123}', idle(),
  );
  const t = parseCopilotTrace(text);
  assert.equal(t.raw, text);
  assert.equal(t.complete, true);
  assert.deepEqual(t.toolCalls.map((x) => x.name), ['Skill', 'Read', 'Grep']);
  assert.equal(t.skillInvocations[0].name, 'demo');
  assert.equal(t.finalText, 'hello');
  assert.equal(parseCopilotTrace(trace(message('I invoked demo Skill'), idle())).toolCalls.length, 0);
  assert.equal(parseCopilotTrace(trace(event('tool.execution_start', { toolName: 'Skill' }), message(), idle())).toolCalls.length, 0);
});

test('Copilot parser excludes malformed, failed, aborted, partial, or subagent-only traces', () => {
  for (const text of [
    '', trace(message()), trace(idle()), trace(message(), idle(), 'not JSON'),
    trace(message(), idle(), event('session.error', { errorType: 'authentication', message: 'login' })),
    trace(message(), event('session.idle', { aborted: true })),
    trace(message(), idle(), event('abort')),
    trace(message(), idle(), event('session.shutdown', { shutdownType: 'error' })),
    trace(event('assistant.message', { content: 'subagent' }, { agentId: 'child' }), idle()),
    trace(message(), event('session.idle', {}, { agentId: 'child' })),
    trace(event('assistant.message', {}), idle()),
    trace(message(), '{"type":"assistant.message"}', idle()),
    trace(message(), idle(), event('assistant.turn_start')),
  ]) assert.equal(parseCopilotTrace(text).complete, false, text);
  const t = parseCopilotTrace(trace(message(), event('assistant.message', { content: 'child', parentToolCallId: 'p' }), idle()));
  assert.equal(t.complete, true);
  assert.equal(t.finalText, 'hello');
});

test('public CLI result and matched successful skill completions are parsed without duplicate evidence', () => {
  const start = event('tool.execution_start', { toolName: 'skill', toolCallId: 's1', arguments: { skill: 'demo' } });
  const complete = event('tool.execution_complete', { toolCallId: 's1', success: true });
  const result = JSON.stringify({ type: 'result', exitCode: 0 });
  for (const evidence of [
    [start, complete],
    [start, complete, event('skill.invoked', { name: 'demo' })],
    [start, event('skill.invoked', { name: 'demo' }), complete],
  ]) {
    const t = parseCopilotTrace(trace(...evidence, message(), result));
    assert.equal(t.complete, true);
    assert.deepEqual(t.toolCalls, [{ name: 'Skill', input: { skill: 'demo' } }]);
  }
  for (const evidence of [
    [start],
    [start, event('tool.execution_complete', { toolCallId: 's1', success: false })],
    [start, event('tool.execution_complete', { toolCallId: 'other', success: true })],
  ]) assert.equal(parseCopilotTrace(trace(...evidence, message(), result)).skillInvocations.length, 0);
  for (const terminal of [{ type: 'result', exitCode: 1 }, { type: 'result' }]) {
    assert.equal(parseCopilotTrace(trace(message(), JSON.stringify(terminal))).complete, false);
  }
});

test('Copilot arguments use explicit public controls, not shell, SDK, or allow-all', () => {
  const args = buildCopilotArgs({ prompt: 'text with "quotes" & shell characters', model: 'fixed-model', usageFile: 'usage.json' });
  assert.equal(args[1], 'text with "quotes" & shell characters');
  assert.ok(args.includes('--no-auto-update'));
  assert.ok(args.includes('--available-tools=skill,view,glob,rg'));
  for (const forbidden of ['--allow-all', '--allow-all-tools', '--allow-all-paths', '--fleet', '--silent', '--resume', '--autopilot']) assert.ok(!args.includes(forbidden));
  assert.equal(args[args.indexOf('--max-ai-credits') + 1], '30');
});

test('prepare copies unchanged source, keeps grader inputs outside workspaces, rejects unsupported checks', (t) => {
  const x = setup(t);
  assert.equal(readFileSync(join(x.opts.skillSnapshot, 'SKILL.md'), 'utf8'), x.content);
  assert.equal(x.opts.skillHash.length, 64);
  assert.equal(readFileSync(join(x.out, 'canary.txt'), 'utf8'), x.opts.canaryToken);
  assert.throws(() => prepareCopilot({ outDir: join(x.dir, 'bad'), skillName: 'demo', skillSourceDir: x.source, cases: [{ ...x.cases[0], fixtures: false, checks: [{ type: 'file_exists', path: 'answer.md' }] }] }), /does not support file_exists/);
});

test('skill audit accepts only the staged enabled skill or clean baseline', (t) => {
  const x = setup(t);
  assert.doesNotThrow(() => auditSkills([], null));
  assert.doesNotThrow(() => auditSkills([{ name: 'demo', path: x.source, enabled: true }], { name: 'demo', path: x.source }));
  assert.doesNotThrow(() => auditSkills([{ name: 'foreign', path: x.dir, enabled: false }], null));
  assert.throws(() => auditSkills({}, null), /expected an array/);
  assert.throws(() => auditSkills([{ name: 'demo', path: x.source }], null), /unsupported/);
  assert.throws(() => auditSkills([{ name: 'demo', path: x.source, enabled: true }], null), /not clean/);
  assert.throws(() => auditSkills([{ name: 'demo', path: x.dir, enabled: true }], { name: 'demo', path: x.source }), /not clean/);
});

test('preflight checks public capabilities without starting a prompt and rejects billing overrides', async (t) => {
  const x = setup(t);
  const pre = await x.runner.preflight({ model: 'synthetic-model' });
  assert.equal(pre.ok, true);
  assert.match(pre.version, /synthetic/);
  assert.equal(existsSync(x.log), false);
  for (const opts of [{}, { model: 'auto' }, { model: 'x', maxAiCredits: 1 }, { model: 'x', timeoutSeconds: 0 }]) {
    assert.equal((await x.runner.preflight(opts)).ok, false);
  }
  const forbidden = createCopilotRunner({ exe: 'do-not-launch', env: { GH_TOKEN: 'not-a-real-token' } });
  assert.match((await forbidden.preflight({ model: 'x' })).problems.join(' '), /GH_TOKEN/);
  const old = createCopilotRunner({ exe: process.execPath, env: {} });
  assert.match((await old.preflight({ model: 'x' })).problems.join(' '), /missing required public option/);
  const home = join(x.dir, 'custom-home');
  mkdirSync(home);
  writeFileSync(join(home, 'settings.json'), '{}');
  assert.match((await x.runner.preflight({ model: 'x', copilotHome: home })).problems.join(' '), /must not contain customizations/);
});

test('synthetic process lifecycle stages clean arms, archives usage, and regrades identically', async (t) => {
  const x = setup(t);
  const result = await x.runner.run(x.cases, x.opts);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.sessions, 2);
  assert.equal(result.costUsd, null);
  assert.equal(result.cases[0].verdict, 'lift');
  const regraded = regradeRun({ tracesDir: join(x.out, 'traces'), cases: x.cases, parse: parseCopilotTrace, canaryToken: x.opts.canaryToken, requireReceipt: true });
  for (const key of ['withScore', 'withoutScore', 'delta', 'verdict', 'withRuns', 'withoutRuns', 'invalidRuns']) assert.deepEqual(regraded[0][key], result.cases[0][key], key);
  const processes = readFileSync(x.log, 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'start');
  assert.equal(processes.length, 2);
  assert.notEqual(processes[0].cwd, processes[1].cwd);
  assert.deepEqual(processes.map((p) => p.hasSkill), [true, false]);
  assert.equal(processes[0].skillContent, x.content);
  for (const p of processes) {
    assert.ok(p.files.includes('fixtures'));
    assert.ok(!p.files.includes('canary.txt'));
    assert.ok(!p.files.some((f) => f.endsWith('.json')));
    assert.ok(!p.prompt.includes('{{fixtures}}'));
    assert.ok(!existsSync(p.cwd));
    assert.ok(!existsSync(p.home));
  }
  const receipt = JSON.parse(readFileSync(join(x.out, 'traces', 'greeting', 'with-1.jsonl.receipt.json'), 'utf8'));
  assert.deepEqual(receipt.usage, { synthetic: true, totalNanoAiu: 1000 });
});

test('built-in skills are disabled through public CLI only in disposable per-job homes', async (t) => {
  const x = setup(t, 'builtin');
  const result = await x.runner.run(x.cases, { ...x.opts, concurrency: 2 });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  const jobs = readFileSync(x.log, 'utf8').trim().split('\n').map(JSON.parse).filter((p) => p.kind === 'start');
  assert.notEqual(jobs[0].home, jobs[1].home);
  assert.equal(JSON.parse(readFileSync(join(x.out, 'eval-output', 'greeting-with-1.skills.initial.json'), 'utf8')).at(-1).enabled, true);
  assert.equal(JSON.parse(readFileSync(join(x.out, 'eval-output', 'greeting-with-1.skills.json'), 'utf8')).at(-1).enabled, false);
  const supplied = join(x.dir, 'supplied-home');
  mkdirSync(supplied);
  const untouched = await x.runner.run(x.cases, { ...x.opts, outputDir: join(x.dir, 'supplied-run', 'eval-output'), copilotHome: supplied });
  assert.equal(untouched.sessions, 0);
  assert.equal(existsSync(join(supplied, 'disabled-builtin')), false);
  const failed = setup(t, 'builtin-disable-failure');
  assert.equal((await failed.runner.run(failed.cases, failed.opts)).sessions, 0);
});

test('bounded scheduler uses exactly approved planned jobs and never exceeds concurrency', async (t) => {
  const x = setup(t, '', { FAKE_COPILOT_DELAY: '150' });
  const result = await x.runner.run(x.cases, { ...x.opts, runs: 3, concurrency: 2 });
  assert.equal(result.sessions, 6);
  assert.equal(result.status, 'passed');
  const events = readFileSync(x.log, 'utf8').trim().split('\n').map(JSON.parse);
  let active = 0;
  let max = 0;
  for (const ev of events) {
    active += ev.kind === 'start' ? 1 : -1;
    max = Math.max(active, max);
  }
  assert.equal(active, 0);
  assert.equal(max, 2);
  assert.equal(new Set(events.filter((e) => e.kind === 'start').map((e) => e.cwd)).size, 6);
});

test('audit failures stop before any prompt or retry', async (t) => {
  const x = setup(t, 'foreign');
  const result = await x.runner.run(x.cases, { ...x.opts, runs: 3 });
  assert.equal(result.status, 'error');
  assert.equal(result.sessions, 0);
  assert.equal(existsSync(x.log), false);
  assert.match(result.caveats.join(' '), /not clean/);
});

test('runtime discovery mismatch or missing audit invalidates the session and offline regrade', async (t) => {
  for (const mode of ['runtime-foreign', 'runtime-missing', 'builtin-runtime-mismatch']) {
    const x = setup(t, mode);
    const result = await x.runner.run(x.cases, { ...x.opts, runs: 3 });
    assert.equal(result.sessions, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.cases[0].withScore, null);
    assert.match(result.caveats.join(' '), /runtime skill audit failed/);
    const regraded = regradeRun({ tracesDir: join(x.out, 'traces'), cases: x.cases, parse: parseCopilotTrace, requireReceipt: true });
    assert.equal(regraded[0].invalidRuns, 1);
    assert.equal(regraded[0].withScore, null);
  }
});

test('nonzero exit, auth failure, malformed JSON, truncation and missing usage cannot become successful grades', async (t) => {
  for (const mode of ['exit-failure', 'auth', 'bad-json', 'truncated', 'missing-usage']) {
    await t.test(mode, async (t) => {
      const x = setup(t, mode);
      const result = await x.runner.run(x.cases, { ...x.opts, runs: 3 });
      assert.equal(result.status, mode === 'auth' ? 'auth_failed' : 'partial');
      assert.equal(result.sessions, 1);
      assert.equal(result.cases[0].withScore, null);
      assert.equal(result.cases[0].invalidRuns, 1);
      const regraded = regradeRun({ tracesDir: join(x.out, 'traces'), cases: x.cases, parse: parseCopilotTrace, requireReceipt: true });
      assert.equal(regraded[0].invalidRuns, 1);
      assert.equal(regraded[0].withScore, null);
    });
  }
});

test('parent timeout terminates the owned process and archives an invalid receipt', async (t) => {
  const x = setup(t, 'hang');
  const childPidFile = join(x.dir, 'child.pid');
  const env = { ...process.env, FAKE_COPILOT_MODE: 'hang', FAKE_COPILOT_LOG: x.log, FAKE_COPILOT_CHILD_PID_FILE: childPidFile };
  for (const k of Object.keys(env)) {
    if (/TOKEN|API_KEY|AUTH_TOKEN|BASE_URL|COPILOT_PROVIDER|COPILOT_ALLOW_ALL|COPILOT_ASSISTED_APPROVAL/i.test(k)) delete env[k];
  }
  x.runner = createCopilotRunner({ transport: 'cli', exe: process.execPath, prefixArgs: [fake], env });
  const start = Date.now();
  const result = await x.runner.run(x.cases, { ...x.opts, timeoutSeconds: 0.5 });
  assert.ok(Date.now() - start < 10_000);
  assert.equal(result.status, 'partial');
  assert.equal(result.sessions, 1);
  const receipt = JSON.parse(readFileSync(join(x.out, 'traces', 'greeting', 'with-1.jsonl.receipt.json'), 'utf8'));
  assert.equal(receipt.timedOut, true);
  const pid = JSON.parse(readFileSync(x.log, 'utf8').trim()).pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const childPid = Number(readFileSync(childPidFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test('smoke runs only the with arm and reports the without arm as unmeasured', async (t) => {
  const x = setup(t);
  const result = await x.runner.run(x.cases, { ...x.opts, ablation: 'none' });
  assert.equal(result.status, 'passed');
  assert.equal(result.sessions, 1);
  assert.equal(result.cases[0].withoutScore, null);
  assert.equal(result.cases[0].verdict, 'unmeasured');
});

test('Copilot history is separated by client/model without changing existing Claude paths', (t) => {
  const x = setup(t);
  const mk = (client, model) => ({ client, model, status: 'passed', cases: [] });
  recordRun(x.dir, 'suite', mk('claude', null));
  const a = recordRun(x.dir, 'suite', mk('copilot', 'model:a'));
  const b = recordRun(x.dir, 'suite', mk('copilot', 'model/a'));
  assert.deepEqual(a.diff, []);
  assert.deepEqual(b.diff, []);
  assert.ok(existsSync(join(x.dir, 'suite', 'latest.json')));
  assert.notEqual(historyRoot(x.dir, { client: 'copilot', model: 'model:a' }), historyRoot(x.dir, { client: 'copilot', model: 'model/a' }));
  assert.equal(loadLatest(x.dir, 'suite', { client: 'copilot', model: 'model:a' }).model, 'model:a');
  assert.equal(loadLatest(x.dir, 'suite').client, 'claude');
});

test('CLI offline regrade selects archived Copilot parser, requires receipts, and rejects client mismatch', (t) => {
  const x = setup(t);
  const traces = join(x.out, 'traces', 'explicit-positive');
  mkdirSync(traces, { recursive: true });
  const tracePath = join(traces, 'with-1.jsonl');
  writeFileSync(tracePath, trace(message(), idle()));
  writeFileSync(`${tracePath}.receipt.json`, JSON.stringify({ valid: true, exitCode: 0 }));
  writeFileSync(join(x.out, 'normalized.json'), JSON.stringify({ client: 'copilot' }));
  const args = [cli, 'regrade', x.out, '--config', fixtureConfig, '--suite', 'demo', '--policy', 'current'];
  const p = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /with=0\.50/);
  const wrong = spawnSync(process.execPath, [...args, '--client', 'claude'], { encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /archived client is copilot/);
  rmSync(`${tracePath}.receipt.json`);
  const missing = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(missing.stdout, /invalid=1/);
  assert.equal(readdirSync(traces).length, 1);
});
