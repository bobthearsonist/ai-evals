import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcpRunner, parseAcpTrace } from '../local/acp-runner.mjs';
import { buildAcpLaunch } from '../local/acp.mjs';
import { compileFeature } from '../local/suite.mjs';
import { regradeRun } from '../local/regrade.mjs';

const scenario = (id) => `
  @case:${id} @should-not-trigger
  Scenario: Respond for ${id}
    When the user asks:
      """
      Say hello for ${id}.
      """
    Then the response contains "hello"
`;

function setup(t, ids) {
  const root = mkdtempSync(join(tmpdir(), 'acp-concurrency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'skill');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\n---\nGreet.\n');
  const cases = compileFeature(`Feature: Concurrent sessions\n${ids.map(scenario).join('')}`, { uri: 'concurrency.feature' });
  return { root, source, cases };
}

// The stub launch passes the runner's options through, so a session can tell
// which case and arm it belongs to.
const jobOf = (options) => ({ caseId: /for (\w+)\./.exec(options.prompt)[1], arm: options.skillName ? 'with' : 'without' });
const answer = (finalText) => ({ finalText, toolCalls: [], raw: [], complete: true, errors: [] });
// Waits for a cross-session signal, but never longer than `ms`: a runner that
// does not overlap sessions must fail these tests, not deadlock them.
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
};
const readReceipt = (root, caseId, name) => JSON.parse(readFileSync(join(root, 'traces', caseId, `${name}.jsonl.receipt.json`), 'utf8'));

for (const concurrency of [1, 3]) test(`ACP runner keeps at most ${concurrency} session(s) in flight${concurrency > 1 ? ' and overlaps them' : ''}`, async (t) => {
  const { root, source, cases } = setup(t, ['alpha']);
  let inFlight = 0;
  let peak = 0;
  const spans = [];
  const runner = createAcpRunner({
    client: 'copilot', launch: (options) => options,
    execute: async () => {
      const span = { start: performance.now() };
      peak = Math.max(peak, ++inFlight);
      await delay(25);
      inFlight--;
      span.end = performance.now();
      spans.push(span);
      return answer('hello');
    },
  });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  const result = await runner.run(cases, {
    ...prepared, outputDir: join(root, 'eval-output'), runs: 3, ablation: 'with-without', model: 'fake-model', concurrency,
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.caveats));
  assert.equal(result.sessions, 6);
  assert.equal(spans.length, 6);
  assert.equal(peak, concurrency);
  const overlapping = spans.some((a, i) => spans.some((b, j) => i < j && a.start < b.end && b.start < a.end));
  assert.equal(overlapping, concurrency > 1);
});

test('ACP runner reports results in case, repeat and arm order when sessions finish out of order', async (t) => {
  const { root, source, cases } = setup(t, ['alpha', 'beta']);
  const started = [];
  const finished = [];
  let allStarted;
  const ready = new Promise((resolve) => { allStarted = resolve; });
  const runner = createAcpRunner({
    client: 'copilot', launch: (options) => options,
    execute: async (options) => {
      const { caseId, arm } = jobOf(options);
      const repeat = started.filter((job) => job.caseId === caseId && job.arm === arm).length + 1;
      started.push({ caseId, arm, repeat });
      const position = started.length;
      if (position === 8) allStarted();
      await within(ready, 1_000);
      // With every session in flight, the first to start is the last to finish.
      await delay((9 - position) * 10);
      finished.push(`${caseId}/${arm}-${repeat}`);
      // Only the first repeat passes the text check, so a score's position shows its repeat.
      return answer(repeat === 1 ? 'hello' : 'goodbye');
    },
  });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  const result = await runner.run(cases, {
    ...prepared, outputDir: join(root, 'eval-output'), runs: 2, ablation: 'with-without', model: 'fake-model', concurrency: 8,
  });
  const schedule = ['alpha', 'beta'].flatMap((id) => [1, 2].flatMap((repeat) => ['with', 'without'].map((arm) => `${id}/${arm}-${repeat}`)));
  assert.deepEqual(started.map(({ caseId, arm, repeat }) => `${caseId}/${arm}-${repeat}`), schedule);
  assert.deepEqual(finished, [...schedule].reverse(), 'sessions completed in reverse schedule order');
  assert.equal(result.sessions, 8);
  assert.deepEqual(result.cases.map((c) => c.id), ['alpha', 'beta']);
  for (const c of result.cases) {
    assert.deepEqual(c.withRuns, [1, 2 / 3]);
    assert.deepEqual(c.withoutRuns, [1, 2 / 3]);
    assert.equal(c.invalidRuns, 0);
  }
  for (const id of ['alpha', 'beta']) for (const arm of ['with', 'without']) for (const repeat of [1, 2]) {
    const receipt = readReceipt(root, id, `${arm}-${repeat}`);
    assert.deepEqual([receipt.caseId, receipt.arm, receipt.repeat, receipt.valid], [id, arm, repeat, true]);
    const trace = parseAcpTrace(readFileSync(join(root, 'traces', id, `${arm}-${repeat}.jsonl`), 'utf8'));
    assert.equal(trace.finalText, repeat === 1 ? 'hello' : 'goodbye', `${id}/${arm}-${repeat} archived its own answer`);
  }
  const replay = regradeRun({ cases, tracesDir: join(root, 'traces'), parse: parseAcpTrace, canaryToken: prepared.canaryToken, requireReceipt: true });
  assert.deepEqual(replay.map((c) => [c.withRuns, c.withoutRuns]), result.cases.map((c) => [c.withRuns, c.withoutRuns]));
});

test('ACP runner with concurrency starts no session after a failure and archives the sessions in flight', async (t) => {
  const { root, source, cases } = setup(t, ['alpha']);
  const events = [];
  let calls = 0;
  let failed;
  const failure = new Promise((resolve) => { failed = resolve; });
  const runner = createAcpRunner({
    client: 'copilot', launch: (options) => options,
    execute: async () => {
      const call = ++calls;
      events.push(`start ${call}`);
      if (call === 2) {
        // A timer cannot fire before the synchronous start of the third session.
        await delay(5);
        events.push(`fail ${call}`);
        failed();
        throw new Error('fake transport failure');
      }
      // The other sessions are still in flight when the second one fails.
      await within(failure, 1_000);
      await delay(20);
      events.push(`end ${call}`);
      return answer('hello');
    },
  });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  const result = await runner.run(cases, {
    ...prepared, outputDir: join(root, 'eval-output'), runs: 5, ablation: 'with-without', model: 'fake-model', concurrency: 3,
  });
  assert.deepEqual(events, ['start 1', 'start 2', 'start 3', 'fail 2', 'end 1', 'end 3']);
  assert.equal(result.sessions, 3);
  assert.equal(result.status, 'partial');
  assert.match(result.caveats.at(-1), /fake transport failure/);
  assert.deepEqual(readdirSync(join(root, 'traces', 'alpha')).sort(), [
    'with-1.jsonl', 'with-1.jsonl.receipt.json', 'with-2.jsonl', 'with-2.jsonl.receipt.json',
    'without-1.jsonl', 'without-1.jsonl.receipt.json',
  ]);
  assert.equal(readReceipt(root, 'alpha', 'with-1').valid, true);
  assert.equal(readReceipt(root, 'alpha', 'with-2').valid, true);
  assert.match(readReceipt(root, 'alpha', 'without-1').error, /fake transport failure/);
  const [c] = result.cases;
  assert.deepEqual(c.withRuns, [1, 1]);
  assert.equal(c.invalidRuns, 1);
  assert.equal(c.partial, true);
  assert.match(c.partialReason, /fake transport failure/);
});

test('ACP runner refuses a concurrency outside 1 to 8 before starting a session', async (t) => {
  const { root, source, cases } = setup(t, ['alpha']);
  const runner = createAcpRunner({
    client: 'copilot', launch: (options) => options,
    execute: async () => { throw new Error('must not launch'); },
  });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  for (const concurrency of [0, 9, 1.5, '2']) {
    await assert.rejects(runner.run(cases, {
      ...prepared, outputDir: join(root, 'eval-output'), runs: 1, ablation: 'none', model: 'fake-model', concurrency,
    }), /concurrency must be an integer from 1 to 8/);
  }
  assert.equal(existsSync(join(root, 'traces')), false);
});

test('concurrent sessions through real fake ACP subprocesses overlap without sharing evidence', async (t) => {
  const { root, source, cases } = setup(t, ['alpha', 'beta']);
  const log = join(root, 'prompts.log');
  const runner = createAcpRunner({
    client: 'copilot',
    launch: (options) => buildAcpLaunch({
      ...options, client: 'custom', profile: 'custom', command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/fake-acp.mjs')],
      env: { FAKE_ACP_MODE: 'normal', FAKE_ACP_HOLD_MS: '300', FAKE_ACP_LOG: log },
    }),
  });
  const prepared = runner.prepare({ outDir: root, skillName: 'demo', skillSourceDir: source, cases });
  const result = await runner.run(cases, {
    ...prepared, outputDir: join(root, 'eval-output'), runs: 2, ablation: 'with-without',
    model: 'synthetic-model', timeoutSeconds: 10, concurrency: 4,
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.caveats));
  assert.equal(result.sessions, 8);
  const pids = new Set();
  for (const id of ['alpha', 'beta']) for (const name of ['with-1', 'without-1', 'with-2', 'without-2']) {
    assert.equal(readReceipt(root, id, name).valid, true);
    const archived = JSON.parse(readFileSync(join(root, 'traces', id, `${name}.jsonl`), 'utf8'));
    const init = archived.transcript.raw.find((event) => event.method === 'initialize' && event.direction === 'in');
    pids.add(init.result.agentInfo.version);
    assert.equal(parseAcpTrace(JSON.stringify(archived)).finalText, 'hello world');
  }
  assert.equal(pids.size, 8, 'every archived session came from its own agent process');
  // Sweep the agents' own prompt start and end times to find the peak overlap.
  const prompts = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(prompts.length, 16);
  let open = 0;
  let peak = 0;
  // At equal timestamps an end sorts first, so touching prompts do not count as overlap.
  for (const { event } of prompts.sort((a, b) => a.at - b.at || (a.event === b.event ? 0 : a.event === 'end' ? -1 : 1))) {
    open += event === 'start' ? 1 : -1;
    peak = Math.max(peak, open);
  }
  assert.ok(peak > 1 && peak <= 4, `peak prompts in flight: ${peak}`);
});
