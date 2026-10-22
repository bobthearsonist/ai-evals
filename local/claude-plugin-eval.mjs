import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CLIENT_STATUS, makeRunResult, registerRunner, validateCapabilities } from './contract.mjs';
import { gradeTranscript, parseClaudeTrace, verdict } from './grade.mjs';
import { compileClaudePlugin } from './compile-claude.mjs';
import { createAcpRunner } from './acp-runner.mjs';

export { verdict };

const MIN_VERSION = [2, 1, 269];

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? m.slice(1, 4).map(Number) : null;
}

export function versionAtLeast(v, min = MIN_VERSION) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

export function plannedSessions({ caseCount, runs, ablation }) {
  return caseCount * runs * (ablation === 'with-without' ? 2 : 1);
}

export function buildArgs({ pluginRoot, outputDir, runs, ablation, maxCostUsd, caseId, concurrency = 1 }) {
  const args = ['plugin', 'eval', pluginRoot, '--runs', String(runs), '-j', String(concurrency), '--ablation', ablation,
    '--max-cost-usd', String(maxCostUsd), '--no-publish', '--keep-temp', '--trust-plugin',
    '--output-dir', outputDir, '--json', join(outputDir, 'stdout.json')];
  if (caseId) args.push('--case', caseId);
  return args;
}

// A run that never reached a final result (e.g. the session ended right after the skill loaded)
// says nothing about answer quality, so it is excluded from scores instead of counted as a failure.
export function isCompleteRun(run, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!run?.tracePath || !exists(run.tracePath)) return true;
  return /"type":"result"/.test(read(run.tracePath));
}

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const PERMISSION_DENIED = /denied because Claude Code is running in don.t ask mode/;

// Refused fixture reads without any successful read are execution failures, not quality failures.
export function isBlockedFromInputs(run, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!run?.tracePath || !exists(run.tracePath)) return false;
  const fileCalls = new Set();
  let denied = 0;
  let succeeded = 0;
  for (const line of read(run.tracePath).split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    for (const part of ev?.message?.content ?? []) {
      if (part?.type === 'tool_use' && FILE_TOOLS.has(part.name)) fileCalls.add(part.id);
      if (part?.type !== 'tool_result' || !fileCalls.has(part.tool_use_id)) continue;
      const text = Array.isArray(part.content) ? part.content.map((x) => x?.text ?? '').join(' ') : String(part.content ?? '');
      if (PERMISSION_DENIED.test(text)) denied++;
      else if (part.is_error !== true) succeeded++;
    }
  }
  return denied > 0 && succeeded === 0;
}

// Copies each run's trace next to the results and drops the temp dir it came from.
export function archiveTraces(aggregatePath, destDir) {
  const agg = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  let n = 0;
  for (const c of agg.cases ?? []) {
    for (const arm of ['with', 'without']) {
      (c.arms?.[arm] ?? []).forEach((r, i) => {
        if (!r.tracePath || !existsSync(r.tracePath)) return;
        const dir = join(destDir, c.name ?? c.id);
        mkdirSync(dir, { recursive: true });
        copyFileSync(r.tracePath, join(dir, `${arm}-${i + 1}.jsonl`));
        const tmp = dirname(dirname(r.tracePath));
        if (basename(tmp).startsWith('claude-eval-')) rmSync(tmp, { recursive: true, force: true });
        n++;
      });
    }
  }
  return n;
}

export function normalizeAggregate(agg, { suite = [], canaryToken, fixtureCaseIds = new Set() } = {}) {
  const cases = (agg.cases ?? []).map((c) => {
    const definition = suite.find((item) => item.id === (c.id ?? c.name ?? c.case));
    if (definition?.schemaVersion === 2) {
      const scores = { with: [], without: [] };
      let invalidRuns = 0;
      for (const arm of ['with', 'without']) for (const run of c.arms?.[arm] ?? []) {
        if (!run.tracePath || !existsSync(run.tracePath)) { invalidRuns++; continue; }
        const transcript = parseClaudeTrace(readFileSync(run.tracePath, 'utf8'));
        if (!transcript.complete || definition.fixtures && isBlockedFromInputs(run)) { invalidRuns++; continue; }
        const grade = gradeTranscript(definition, transcript, { arm, canaryToken });
        if (grade.invalid || grade.score == null) invalidRuns++;
        else scores[arm].push(grade.score);
      }
      const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      const withScore = mean(scores.with);
      const withoutScore = mean(scores.without);
      return {
        id: definition.id, withScore, withoutScore,
        delta: withScore != null && withoutScore != null ? withScore - withoutScore : null,
        withRuns: scores.with, withoutRuns: scores.without,
        verdict: verdict(scores.with, scores.without), invalidRuns,
        partial: Boolean(c.partial) || invalidRuns > 0 || scores.with.length === 0,
        partialReason: invalidRuns ? 'required transcript evidence unavailable' : c.partialReason ?? null,
        costUsd: ['with', 'without'].flatMap((arm) => c.arms?.[arm] ?? [])
          .reduce((sum, run) => typeof run.costUsd === 'number' ? (sum ?? 0) + run.costUsd : sum, null),
      };
    }
    const a = c.aggregates ?? {};
    const usesFixtures = definition?.fixtures || fixtureCaseIds.has(c.id ?? c.name);
    const valid = (runs) => (runs ?? []).filter((r) => isCompleteRun(r) && !(usesFixtures && isBlockedFromInputs(r)));
    const mean = (runs) => (runs?.length ? runs.reduce((s, r) => s + (r.score ?? 0), 0) / runs.length : null);
    const sum = (...arms) => {
      const costs = arms.flatMap((r) => r ?? []).map((r) => r.costUsd).filter((x) => typeof x === 'number');
      return costs.length ? costs.reduce((s, x) => s + x, 0) : null;
    };
    const invalidRuns = ['with', 'without'].reduce((n, k) => n + (c.arms?.[k]?.length ?? 0) - valid(c.arms?.[k]).length, 0);
    const withScore = mean(valid(c.arms?.with)) ?? a.score ?? null;
    const withoutScore = mean(valid(c.arms?.without)) ?? a.baselineScore ?? a.withoutScore ?? null;
    const withRuns = valid(c.arms?.with).map((r) => r.score ?? 0);
    const withoutRuns = valid(c.arms?.without).map((r) => r.score ?? 0);
    return {
      id: c.id ?? c.name ?? c.case ?? 'unknown',
      withScore,
      withoutScore,
      delta: withScore != null && withoutScore != null ? withScore - withoutScore : (a.delta ?? null),
      verdict: verdict(withRuns, withoutRuns),
      withRuns,
      withoutRuns,
      invalidRuns,
      partial: Boolean(c.partial),
      partialReason: c.partialReason ?? null,
      costUsd: sum(c.arms?.with, c.arms?.without),
    };
  });
  const hostGraded = suite.some((c) => c.schemaVersion === 2);
  const scores = cases.flatMap((c) => c.withRuns);
  const overallScore = hostGraded
    ? scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
    : agg.aggregates?.overallScore ?? null;
  return { cases, overallScore, costUsd: agg.costUsd ?? null, claudeVersion: agg.claudeVersion ?? null, partial: Boolean(agg.partial) || cases.some((c) => c.partial) };
}

export function createClaudeRunner(options = {}) {
  return createAcpRunner({ ...options, client: 'claude' });
}

export function createLegacyClaudeRunner({ exe = 'claude' } = {}) {
  const run = (args) => spawnSync(exe, args, { encoding: 'utf8', shell: false, windowsHide: true });
  return registerRunner({
    id: 'claude',
    transport: 'native',
    capabilities: { hermetic: false, skillTrace: true, toolEvidence: true, traceEvidence: true, usageObservable: true, hardLimits: false, implemented: true },
    async preflight() {
      const problems = [];
      const v = run(['--version']);
      if (v.error || v.status !== 0) return { ok: false, problems: [`claude not runnable: ${v.error?.message ?? v.stderr}`] };
      const ver = parseVersion(v.stdout);
      if (!ver || !versionAtLeast(ver)) problems.push(`claude ${v.stdout.trim()} < ${MIN_VERSION.join('.')}`);
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        if (process.env[k]) problems.push(`${k} is set; run would bill API instead of subscription`);
      }
      return { ok: problems.length === 0, version: v.stdout.trim(), problems };
    },
    plannedSessions,
    // Builds the client-specific harness (here a throwaway plugin) from neutral cases.
    prepare(opts) {
      return compileClaudePlugin(opts);
    },
    parseTrace: parseClaudeTrace,
    async run(suite, { pluginRoot, outputDir, runs, ablation, maxCostUsd = 5, caseId, concurrency = 1, canaryToken }) {
      for (const c of suite.filter((item) => !caseId || item.id === caseId)) {
        const problems = validateCapabilities(c, { toolEvidence: true, traceEvidence: true });
        if (problems.length) throw new Error(`unsupported Claude case ${c.id}: ${problems.join('; ')}`);
      }
      const proc = run(buildArgs({ pluginRoot, outputDir, runs, ablation, maxCostUsd, caseId, concurrency }));
      const base = { client: 'claude', outputDir, caveats: ['subscription login used; not hermetic', 'cost is a list-price estimate'] };
      if (proc.error) return makeRunResult({ ...base, status: CLIENT_STATUS.ERROR, caveats: [...base.caveats, proc.error.message] });
      const aggPath = findAggregate(outputDir);
      if (!aggPath) {
        const auth = proc.status === 2 || /auth/i.test(`${proc.stderr}${proc.stdout}`);
        return makeRunResult({ ...base, status: auth ? CLIENT_STATUS.AUTH_FAILED : CLIENT_STATUS.ERROR, caveats: [...base.caveats, `no aggregate-result.json; exit ${proc.status}; ${String(proc.stderr).slice(0, 500)}`] });
      }
      const n = normalizeAggregate(JSON.parse(readFileSync(aggPath, 'utf8')), { suite, canaryToken });
      archiveTraces(aggPath, join(outputDir, '..', 'traces'));
      const hostGraded = suite.some((c) => c.schemaVersion === 2);
      const status = n.partial || proc.status === 2 ? CLIENT_STATUS.PARTIAL
        : hostGraded ? n.overallScore === 1 ? CLIENT_STATUS.PASSED : CLIENT_STATUS.BELOW_THRESHOLD
          : proc.status === 0 ? CLIENT_STATUS.PASSED : CLIENT_STATUS.BELOW_THRESHOLD;
      return makeRunResult({
        ...base, status, clientVersion: n.claudeVersion, overallScore: n.overallScore, costUsd: n.costUsd,
        cases: n.cases, sessions: plannedSessions({ caseCount: caseId ? 1 : suite.length, runs, ablation }),
      });
    },
  });
}

function findAggregate(dir) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'aggregate-result.json') return p;
    }
  }
  return null;
}
