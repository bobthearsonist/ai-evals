#!/usr/bin/env node
// Runs every suite in parallel (separate processes) with per-suite concurrency.
// usage: node local/run-all.mjs [--concurrency 4] [--runs 3] [--approve-sessions N]
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfig, suiteSettings } from './config.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderMarkdown } from './summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--help')) {
  console.log('usage: ai-evals run-all [--config evals/evals.json] [--suites a,b] [--runs 3] [--concurrency 4] [--approve-sessions N]');
  process.exit(0);
}
const { values } = parseArgs({
  options: { concurrency: { type: 'string', default: '4' }, runs: { type: 'string', default: '3' }, 'approve-sessions': { type: 'string' }, suites: { type: 'string' }, config: { type: 'string' }, 'cases-dir': { type: 'string' }, 'output-dir': { type: 'string' }, 'results-dir': { type: 'string' }, 'skill-root': { type: 'string' }, client: { type: 'string' }, exe: { type: 'string' } },
});
const config = resolveConfig({ configPath: values.config, flags: { casesDir: values['cases-dir'], resultsDir: values['results-dir'] } });
const casesRoot = config.casesDir;
const passthrough = ['config', 'cases-dir', 'output-dir', 'results-dir', 'skill-root', 'client', 'exe'].flatMap((k) => (values[k] ? [`--${k}`, values[k]] : []));
const only = values.suites?.split(',');
const folder = (s) => join(casesRoot, suiteSettings(config, s).casesFolder);
const candidates = Object.keys(config.suites).length ? Object.keys(config.suites) : readdirSync(casesRoot);
const suites = candidates.filter((s) => (!only || only.includes(s)) && existsSync(folder(s)) && readdirSync(folder(s)).some((f) => f.endsWith('.json')));
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
if (!Number.isInteger(Number(values.concurrency)) || Number(values.concurrency) < 1 || Number(values.concurrency) > 8) throw new Error('--concurrency must be an integer from 1 to 8');
if (only?.some((s) => !suites.includes(s))) throw new Error(`unknown or empty suite in --suites: ${values.suites}`);
if (!suites.length) throw new Error(`no suites found: ${casesRoot}`);
const perSuite = (s) => readdirSync(folder(s)).filter((f) => f.endsWith('.json')).length * runs * 2;
const total = suites.reduce((n, s) => n + perSuite(s), 0);
if (Number(values['approve-sessions']) !== total) {
  console.log(`approval gate: this starts ${total} live session(s) across ${suites.length} suites; pass --approve-sessions ${total} to proceed`);
  process.exit(1);
}

const results = await Promise.all(suites.map((s) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, 'cli.mjs'), 'run', '--suite', s, '--runs', String(runs), '--concurrency', values.concurrency, '--approve-sessions', String(perSuite(s)), ...passthrough], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (error) => resolve({ suite: s, status: 'error', error: error.message }));
  p.on('close', (code) => {
    try {
      const parsed = JSON.parse(out);
      resolve({ ...parsed, suite: s, diffs: err.split(/\r?\n/).filter((l) => l.startsWith('diff ')), status: code === 0 ? parsed.status : 'error', error: code === 0 ? null : err.trim() });
    } catch (error) {
      resolve({ suite: s, status: 'error', error: `exit ${code}: ${err.trim() || out.trim() || error.message}` });
    }
  });
})));
let cost = 0;
for (const r of results) {
  cost += r.costUsd ?? 0;
  console.log(`${r.suite}: ${r.status} score=${r.overallScore?.toFixed?.(2)} cost=$${r.costUsd?.toFixed?.(2)}`);
  if (r.error) console.error(r.error);
  for (const c of r.cases ?? []) console.log(`  ${c.id}: with=${c.withScore?.toFixed(2)} without=${c.withoutScore?.toFixed(2)} delta=${c.delta?.toFixed(2)} [${c.verdict}]${c.invalidRuns ? ` (${c.invalidRuns} invalid run(s) excluded)` : ''}`);
}
for (const r of results) for (const d of r.diffs ?? []) console.log(`vs previous ${r.suite} ${d.slice(5)}`);
const resultsDir = config.resultsDir;
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, 'summary.md'), renderMarkdown(results.map((r) => ({ ...r, cases: r.cases ?? [] }))));
console.log(`total cost ~$${cost.toFixed(2)}`);
process.exitCode = results.some((r) => !['passed', 'below_threshold'].includes(r.status)) ? 2 : 0;
