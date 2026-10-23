#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfig, suiteSettings } from './config.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderMarkdown } from './summary.mjs';
import { loadSuite } from './suite.mjs';
import { createAcpRunner } from './acp-runner.mjs';
import { registerStubs } from './stubs.mjs';
import { getRunner, validateCapabilities } from './contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try {
if (process.argv.includes('--help')) {
  console.log('usage: ai-evals <run-all|run|smoke|preflight> [flags]\n\nFlags: --runners ID[,ID] | --client ID --suite NAME | --suites A,B --case ID (repeatable for smoke)\n       --config PATH --cases-dir PATH --skill-root ROOTS --output-dir PATH --results-dir PATH\n       --runs N --concurrency 1..8 --model ID --<client>-model ID --<client>-exe PATH\n       --acp-profile PATH --claude-acp-profile PATH --copilot-acp-profile PATH\n       --approve-sessions N --dry-run --json\nExit codes: 0 success; 1 evaluation/preflight failure or below threshold; 2 usage/config/approval error.');
  process.exit(0);
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    concurrency: { type: 'string', default: '4' }, runs: { type: 'string', default: '3' },
    'approve-sessions': { type: 'string' }, suite: { type: 'string' }, suites: { type: 'string' },
    case: { type: 'string', multiple: true }, config: { type: 'string' }, 'cases-dir': { type: 'string' },
    'output-dir': { type: 'string' }, 'results-dir': { type: 'string' }, 'skill-root': { type: 'string' },
    client: { type: 'string' }, runners: { type: 'string', multiple: true }, exe: { type: 'string' },
    model: { type: 'string' }, 'copilot-model': { type: 'string' },
    'claude-model': { type: 'string' }, 'opencode-model': { type: 'string' },
    'claude-exe': { type: 'string' }, 'copilot-exe': { type: 'string' }, 'opencode-exe': { type: 'string' },
    'timeout-seconds': { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    'acp-profile': { type: 'string' },
    'claude-acp-profile': { type: 'string' }, 'copilot-acp-profile': { type: 'string' },
  },
});
const command = positionals[0] ?? 'run-all';
if (!['run-all', 'run', 'smoke', 'preflight'].includes(command) || positionals.length > 1) {
  throw new Error('--runners supports preflight, smoke, run and run-all; regrade one archived run at a time');
}
if (values.client && values.runners) throw new Error('use either --client or --runners, not both');
const ids = (values.runners ?? [values.client ?? 'claude']).flatMap((s) => s.split(',').map((v) => v.trim()));
if (ids.some((s) => !s) || new Set(ids).size !== ids.length) throw new Error('--runners must contain distinct non-empty runner IDs');
if (ids.length > 1 && (values.exe || values.model || values['acp-profile'])) {
  throw new Error('multiple runners require client-specific options, not ambiguous --exe/--model/--acp-profile');
}
createAcpRunner({ client: 'claude' });
createAcpRunner({ client: 'copilot' });
registerStubs();
const runners = ids.map(getRunner);
for (const r of runners) {
  if (!r.capabilities.implemented) {
    throw new Error(`${r.id}: not implemented`);
  }
}
const runnerArgs = (id) => {
  const opts = {
    client: id, exe: values[`${id}-exe`] ?? values.exe,
    model: values[`${id}-model`] ?? values.model,
    'acp-profile': values[`${id}-acp-profile`] ?? values['acp-profile'],
    'timeout-seconds': values['timeout-seconds'],
  };
  return Object.entries(opts).flatMap(([k, v]) => v === undefined ? [] : [`--${k}`, v]);
};
async function invoke(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'cli.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('error', (e) => done({ code: null, out, err: e.message }));
    child.once('close', (code) => done({ code, out, err }));
  });
}
const config = resolveConfig({ configPath: values.config, flags: { casesDir: values['cases-dir'], resultsDir: values['results-dir'] } });
let suites = [];
const counts = new Map();
if (command !== 'preflight') {
  if (command !== 'run-all' && !values.suite) throw new Error('--suite is required');
  if (values.suite && values.suites) throw new Error('use either --suite or --suites, not both');
  if (command !== 'run-all' && values.suites) throw new Error('--suites is for run-all; use --suite');
  const only = (values.suites ?? values.suite)?.split(',');
  const folder = (s) => join(config.casesDir, suiteSettings(config, s).casesFolder);
  const candidates = Object.keys(config.suites).length ? Object.keys(config.suites) : readdirSync(config.casesDir);
  suites = candidates.filter((s) => (!only || only.includes(s)) && existsSync(folder(s)) && readdirSync(folder(s)).some((f) => f.endsWith('.feature') || f.endsWith('.json') && !f.endsWith('.samples.json')));
  if (only?.some((s) => !suites.includes(s))) throw new Error(`unknown or empty suite in --suites: ${only.join(',')}`);
  if (!suites.length) throw new Error(`no suites found: ${config.casesDir}`);
  for (const s of suites) {
    const cases = loadSuite(folder(s));
    const caseIds = values.case ?? [];
    if (command !== 'smoke' && caseIds.length > 1) throw new Error('--case may be repeated only for smoke');
    if (new Set(caseIds).size !== caseIds.length) throw new Error('--case values must be distinct');
    for (const id of caseIds) if (!cases.some((c) => c.id === id)) throw new Error(`unknown case: ${id} in ${s}`);
    const selectedIds = command === 'smoke' ? (caseIds.length ? caseIds : [cases[0].id]) : caseIds;
    const selected = new Set(selectedIds);
    const problems = cases.filter((c) => selected.size ? selected.has(c.id) : true)
      .flatMap((c) => runners.flatMap((r) => validateCapabilities(c, r.capabilities).map((problem) => `${r.id}/${s}/${c.id}: ${problem}`)));
    if (problems.length) throw new Error(`unsupported execution evidence:\n- ${problems.join('\n- ')}`);
    counts.set(s, command === 'smoke' ? selectedIds.length : caseIds.length ? 1 : cases.length);
  }
}
const runs = command === 'smoke' ? 1 : Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
if (!Number.isInteger(Number(values.concurrency)) || Number(values.concurrency) < 1 || Number(values.concurrency) > 8) throw new Error('--concurrency must be an integer from 1 to 8');
const planned = (s, r) => r.plannedSessions({ caseCount: counts.get(s), runs, ablation: command === 'smoke' ? 'none' : 'with-without' });
const total = suites.reduce((n, s) => n + runners.reduce((m, r) => m + planned(s, r), 0), 0);
if (values['dry-run']) {
  const result = { suites, runners: ids, transport: 'acp', runs, plannedSessions: total };
  console.log(values.json ? JSON.stringify(result, null, 2) : `dry run: ${suites.length} suite(s), ${ids.length} runner(s), ${total} session(s) planned`);
  process.exit(0);
}
if (command !== 'preflight' && Number(values['approve-sessions']) !== total) {
  throw new Error(`approval gate: this starts ${total} live session(s) across ${suites.length} suites and ${runners.length} runner(s); pass --approve-sessions ${total} to proceed`);
}
const passthrough = ['config', 'cases-dir', 'output-dir', 'results-dir', 'skill-root'].flatMap((k) => values[k] === undefined ? [] : [`--${k}`, values[k]]);
// Check every selected client before any paid work, not after another client has spent its budget.
const preflights = [];
for (const id of ids) {
  const p = await invoke(['preflight', ...runnerArgs(id)]);
  let result;
  try { result = JSON.parse(p.out); } catch { result = { ok: false, problems: [p.err || p.out || `exit ${p.code}`] }; }
  preflights.push({ client: id, ...result, ok: p.code === 0 && result.ok === true });
}
if (command === 'preflight') {
  console.log(JSON.stringify(preflights, null, 2));
  process.exit(preflights.every((p) => p.ok) ? 0 : 1);
}
const failed = preflights.filter((p) => !p.ok);
const results = failed.map((p) => ({ client: p.client, transport: 'acp', status: 'error', error: `preflight failed:\n- ${(p.problems ?? []).join('\n- ')}`, cases: [] }));
if (!failed.length) {
  // Suite/runner pairs are serial: --concurrency is a global ceiling, not multiplied by the suite count.
  jobs: for (const s of suites) for (const r of runners) {
    const p = await invoke([
      command === 'smoke' ? 'smoke' : 'run', '--suite', s, '--runs', String(runs), '--json',
      '--concurrency', values.concurrency, '--approve-sessions', String(planned(s, r)),
      ...passthrough, ...runnerArgs(r.id), ...(values.case ?? []).flatMap((id) => ['--case', id]),
    ]);
    let result;
    try {
      const parsed = JSON.parse(p.out);
      result = { ...parsed, suite: s, client: r.id, diffs: p.err.split(/\r?\n/).filter((l) => l.startsWith('diff ')) };
      if (p.code !== 0 && !['passed', 'below_threshold'].includes(result.status)) result.error = p.err.trim() || parsed.caveats?.at(-1) || `exit ${p.code}`;
      if (p.code !== 0 && result.status === 'passed') result.status = 'error';
    } catch {
      result = { suite: s, client: r.id, status: 'error', cases: [], error: `exit ${p.code}: ${p.err.trim() || p.out.trim() || 'invalid child output'}` };
    }
    results.push(result);
    if (!['passed', 'below_threshold'].includes(result.status)) break jobs;
  }
}
if (!values.json) for (const r of results) {
  console.log(`${r.suite ?? 'preflight'}: ${r.status} client=${r.client} transport=acp${r.model ? ` model=${r.model}` : ''} score=${r.overallScore?.toFixed?.(2) ?? '-'} cost=${typeof r.costUsd === 'number' ? `${r.costUsd.toFixed(2)}` : 'unknown'}`);
  if (r.error) console.error(`error: ${r.error.replace(/^error: /, '')}`);
  for (const c of r.cases ?? []) console.log(`  ${c.id}: with=${c.withScore?.toFixed(2) ?? '-'} without=${c.withoutScore?.toFixed(2) ?? '-'} delta=${c.delta?.toFixed(2) ?? '-'} [${c.verdict}]${c.invalidRuns ? ` (${c.invalidRuns} invalid run(s) excluded)` : ''}`);
  for (const d of r.diffs ?? []) console.log(`vs previous ${r.client}/${r.suite} ${d.slice(5)}`);
}
mkdirSync(config.resultsDir, { recursive: true });
writeFileSync(join(config.resultsDir, command === 'smoke' ? 'smoke-summary.md' : 'summary.md'), renderMarkdown(results.map((r) => ({ ...r, cases: r.cases ?? [] }))));
const knownCost = results.reduce((n, r) => n + (r.costUsd ?? 0), 0);
const knownCostMessage = `known cost ~${knownCost.toFixed(2)}${results.some((r) => r.costUsd == null) ? '; some USD costs unknown' : ''}`;
if (values.json) console.log(JSON.stringify({ suites, runners: ids, runs, plannedSessions: total, results, knownCostUsd: knownCost, costComplete: results.every((r) => r.costUsd != null) }, null, 2));
else console.log(knownCostMessage);
process.exitCode = results.some((r) => r.status !== 'passed') ? 1 : 0;
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
