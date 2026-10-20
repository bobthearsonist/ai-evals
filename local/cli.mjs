#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getRunner } from './contract.mjs';
import { loadSuite } from './compile-claude.mjs';
import { createClaudeRunner } from './claude-plugin-eval.mjs';
import { registerStubs } from './stubs.mjs';
import { recordRun } from './summary.mjs';
import { regradeRun } from './regrade.mjs';
import { resolveConfig, suiteSettings } from './config.mjs';

if (process.argv[2] === 'run-all') {
  process.argv.splice(2, 1);
  await import('./run-all.mjs');
  process.exit();
}
if (process.argv.includes('--help') || !process.argv[2]) {
  console.log('usage: ai-evals <preflight|smoke|run|regrade <runDir>|run-all> [--config evals/evals.json] [--suite NAME] [--approve-sessions N]');
  process.exit(0);
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    client: { type: 'string', default: 'claude' },
    suite: { type: 'string' },
    runs: { type: 'string' },
    case: { type: 'string' },
    'approve-sessions': { type: 'string' },
    'max-cost-usd': { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '1' },
    exe: { type: 'string' },
    'skill-root': { type: 'string' },
    config: { type: 'string' },
    'cases-dir': { type: 'string' },
    'output-dir': { type: 'string' },
    'results-dir': { type: 'string' },
  },
});

const config = resolveConfig({ configPath: values.config, flags: { skillRoot: values['skill-root'], casesDir: values['cases-dir'], outputDir: values['output-dir'], resultsDir: values['results-dir'] } });
const SKILL_ROOTS = config.skillsRoots;
const findSkill = (name) => SKILL_ROOTS.map((r) => join(r, name)).find((p) => existsSync(join(p, 'SKILL.md')));
const command = positionals[0];
createClaudeRunner(values.exe ? { exe: values.exe } : {});
registerStubs();
const runner = getRunner(values.client);

if (!runner.capabilities.implemented) {
  console.error(`${runner.id}: not implemented`);
  process.exit(3);
}
if (command === 'preflight') {
  const r = await runner.preflight({});
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (command !== 'smoke' && command !== 'run' && command !== 'regrade') {
  console.error('usage: ai-evals <preflight|smoke|run|regrade <runDir>> --suite NAME [--config evals/evals.json] [--approve-sessions N]');
  process.exit(64);
}

if (!values.suite) {
  console.error('--suite is required');
  process.exit(64);
}
const { skill: skillName, casesFolder } = suiteSettings(config, values.suite);
const suiteDir = join(config.casesDir, casesFolder);
const cases = loadSuite(suiteDir);
const fixturesDir = join(suiteDir, 'fixtures');
if (command === 'regrade') {
  if (!positionals[1]) throw new Error('regrade requires a run directory');
  const runDir = resolve(positionals[1]);
  if (!existsSync(join(runDir, 'traces'))) throw new Error(`no archived traces: ${runDir}`);
  const meta = JSON.parse(readFileSync(join(runDir, 'normalized.json'), 'utf8'));
  const out = regradeRun({ tracesDir: join(runDir, 'traces'), cases, parse: runner.parseTrace, canaryToken: meta.canaryToken });
  for (const c of out) console.log(`${c.id}: with=${c.withScore?.toFixed(2)} without=${c.withoutScore?.toFixed(2)} [${c.verdict}]${c.invalidRuns ? ' invalid=' + c.invalidRuns : ''}`);
  process.exit(0);
}
const skillDir = findSkill(skillName);
if (!skillDir) {
  console.error(`skill "${skillName}" not found under: ${SKILL_ROOTS.join('; ')}`);
  process.exit(1);
}
const smoke = command === 'smoke';
const caseId = smoke ? (values.case ?? cases[0].id) : values.case;
const runs = smoke ? 1 : Number(values.runs ?? 3);
const ablation = smoke ? 'none' : 'with-without';
const planned = runner.plannedSessions({ caseCount: caseId ? 1 : cases.length, runs, ablation });
const approved = Number(values['approve-sessions'] ?? 0);

if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
if (caseId && !cases.some((c) => c.id === caseId)) throw new Error(`unknown case: ${caseId}`);
if (!Number.isInteger(Number(values.concurrency)) || Number(values.concurrency) < 1 || Number(values.concurrency) > 8) throw new Error('--concurrency must be an integer from 1 to 8');
if (!Number.isFinite(Number(values['max-cost-usd'])) || Number(values['max-cost-usd']) <= 0) throw new Error('--max-cost-usd must be positive');
const pre = await runner.preflight({});
if (!pre.ok) {
  console.error(`preflight failed:\n- ${pre.problems.join('\n- ')}`);
  process.exit(1);
}
if (!(approved >= planned && planned > 0)) {
  console.error(`approval gate: this run starts ${planned} live session(s); pass --approve-sessions ${planned} to proceed`);
  process.exit(4);
}

const ts = `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.suite}`;
const outDir = join(config.outputDir, `${ts}-${command}`);
mkdirSync(outDir, { recursive: true });
const { pluginRoot, skillHash, canaryToken } = runner.prepare({
  outDir, skillName, skillSourceDir: skillDir, fixturesDir: existsSync(fixturesDir) ? fixturesDir : null, cases,
});
const result = await runner.run(cases, { pluginRoot, outputDir: join(outDir, 'eval-output'), runs, ablation, maxCostUsd: Number(values['max-cost-usd']), caseId, concurrency: Number(values.concurrency) });
const normalized = { ...result, skillSha256: skillHash, canaryToken, command, runs, ablation, plannedSessions: planned };
writeFileSync(join(outDir, 'normalized.json'), JSON.stringify(normalized, null, 2));
if (!smoke && result.cases?.length) {
  const { diff } = recordRun(config.resultsDir, values.suite, normalized);
  for (const d of diff) if (d.verdictChange || d.deltaChange) console.error(`diff ${d.id}: with ${d.withChange}, delta ${d.deltaChange}${d.verdictChange ? `, verdict ${d.verdictChange}` : ''}`);
}
console.log(JSON.stringify(normalized, null, 2));
process.exit(['passed', 'below_threshold'].includes(result.status) ? 0 : 2);
