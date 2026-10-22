#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getRunner, validateCapabilities } from './contract.mjs';
import { loadSuite } from './suite.mjs';
import { registerStubs } from './stubs.mjs';
import { recordRun } from './summary.mjs';
import { regradeRun } from './regrade.mjs';
import { resolveConfig, suiteSettings } from './config.mjs';
import { archivePolicy, archiveReplay, policySnapshot, replayPolicy } from './policy.mjs';
import { createAcpRunner } from './acp-runner.mjs';
import { judgeArchive } from './judge-cli.mjs';

if (process.argv[2] === 'run-all') {
  process.argv.splice(2, 1);
  await import('./run-all.mjs');
  process.exit();
}
if (process.argv.some((a) => a === '--runners' || a.startsWith('--runners='))
  && !['validate', 'regrade', 'judge'].includes(process.argv[2])) {
  await import('./run-all.mjs');
  process.exit();
}
if (process.argv.includes('--help') || !process.argv[2]) {
  console.log('usage: ai-evals <validate|preflight|smoke|run|regrade <runDir>|judge <runDir>|run-all> [--config evals/evals.json] [--suite NAME] [--client claude|copilot | --runners claude,copilot] [--dry-run] [--policy recorded|current] [--approve-sessions N]');
  process.exit(0);
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    client: { type: 'string' },
    suite: { type: 'string' },
    runs: { type: 'string' },
    case: { type: 'string' },
    'approve-sessions': { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    exe: { type: 'string' },
    model: { type: 'string' },
    'timeout-seconds': { type: 'string' },
    'skill-root': { type: 'string' },
    config: { type: 'string' },
    'cases-dir': { type: 'string' },
    'output-dir': { type: 'string' },
    'results-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    policy: { type: 'string' },
    'acp-profile': { type: 'string' },
    rubric: { type: 'string' },
  },
});

const config = resolveConfig({ configPath: values.config, flags: { skillRoot: values['skill-root'], casesDir: values['cases-dir'], outputDir: values['output-dir'], resultsDir: values['results-dir'] } });
const SKILL_ROOTS = config.skillsRoots;
const findSkill = (name) => SKILL_ROOTS.map((r) => join(r, name)).find((p) => existsSync(join(p, 'SKILL.md')));
const command = positionals[0];
if (values.policy !== undefined && command !== 'regrade') throw new Error('--policy is only supported by regrade');
if (values.rubric !== undefined && command !== 'judge') throw new Error('--rubric is only supported by judge');
createAcpRunner({ client: 'claude' });
createAcpRunner({ client: 'copilot' });
registerStubs();
if (values['acp-profile'] && values.exe) throw new Error('--acp-profile contains its command; do not combine with --exe');
if (['claude', 'copilot'].includes(values.client ?? 'claude')) {
  createAcpRunner({
    client: values.client ?? 'claude', exe: values.exe,
    ...(values['acp-profile'] ? { acpProfile: JSON.parse(readFileSync(resolve(values['acp-profile']), 'utf8')) } : {}),
  });
}
let runner = getRunner(values.client ?? 'claude');
if (command === 'judge') {
  if (positionals.length !== 2) throw new Error('judge requires one run directory');
  if (!values.client || !values.model) throw new Error('judge requires an explicit --client and --model');
  if (values.exe || values.suite || values.runs || values['acp-profile']) {
    throw new Error('judge does not support --exe, --suite, --runs or --acp-profile; it reads archived answers only');
  }
  const runDir = resolve(positionals[1]);
  const meta = JSON.parse(readFileSync(join(runDir, 'normalized.json'), 'utf8'));
  if (meta.transport !== 'acp') throw new Error('only ACP archives are supported');
  const archivedRunner = createAcpRunner({ client: meta.client });
  const timeoutMs = Number(values['timeout-seconds'] ?? 120) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('invalid judge timeout');
  const result = await judgeArchive({
    runDir, parse: archivedRunner.parseTrace, requireReceipt: true,
    caseIds: values.case ? [values.case] : undefined, rubricPath: values.rubric && resolve(values.rubric),
    model: values.model, client: values.client, approveSessions: Number(values['approve-sessions'] ?? 0), timeoutMs, dryRun: values['dry-run'],
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.dryRun || result.assessments.length > 0 && result.assessments.every((assessment) => assessment.judgement?.verdict === 'pass') ? 0 : 2);
}
const runnerOptions = {
  model: values.model,
  timeoutSeconds: Number(values['timeout-seconds'] ?? 120),
};

if (!runner.capabilities.implemented && !['validate', 'regrade'].includes(command) && !values['dry-run']) {
  console.error(`${runner.id}: not implemented`);
  process.exit(3);
}
if (command === 'preflight') {
  const r = await runner.preflight(runnerOptions);
  console.log(JSON.stringify({ transport: 'acp', ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (!['smoke', 'run', 'regrade', 'validate'].includes(command)) {
  console.error('usage: ai-evals <validate|preflight|smoke|run|regrade <runDir>> --suite NAME [--config evals/evals.json] [--approve-sessions N]');
  process.exit(64);
}

if (command === 'regrade') {
  if (!positionals[1]) throw new Error('regrade requires a run directory');
  const runDir = resolve(positionals[1]);
  if (!existsSync(join(runDir, 'traces'))) throw new Error(`no archived traces: ${runDir}`);
  const meta = JSON.parse(readFileSync(join(runDir, 'normalized.json'), 'utf8'));
  if (meta.transport !== 'acp') throw new Error('only ACP archives are supported');
  if (values.client && meta.client && values.client !== meta.client) throw new Error(`archived client is ${meta.client}, not ${values.client}`);
  runner = createAcpRunner({ client: meta.client });
  let currentCases;
  if (values.policy === 'current') {
    if (!values.suite) throw new Error('--suite is required for --policy current');
    currentCases = loadSuite(join(config.casesDir, suiteSettings(config, values.suite).casesFolder));
  }
  const policy = replayPolicy(runDir, { currentCases, mode: values.policy ?? 'recorded' });
  const out = regradeRun({ tracesDir: join(runDir, 'traces'), cases: policy.cases, parse: runner.parseTrace, canaryToken: meta.canaryToken, requireReceipt: true });
  const path = archiveReplay(runDir, policy, out);
  for (const c of out) console.log(`${c.id}: with=${c.withScore?.toFixed(2)} without=${c.withoutScore?.toFixed(2)} [${c.verdict}]${c.invalidRuns ? ' invalid=' + c.invalidRuns : ''}`);
  console.log(`policy=${policy.mode} sha256=${policy.sha256} assessment=${path}`);
  process.exit(0);
}
if (!values.suite) {
  console.error('--suite is required');
  process.exit(64);
}
const { skill: skillName, casesFolder } = suiteSettings(config, values.suite);
const suiteDir = join(config.casesDir, casesFolder);
const cases = loadSuite(suiteDir);
const fixturesDir = join(suiteDir, 'fixtures');
if (command === 'validate') {
  console.log(JSON.stringify({ suite: values.suite, caseCount: cases.length, policy: policySnapshot(cases) }, null, 2));
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
const capabilityProblems = cases.filter((c) => !caseId || c.id === caseId)
  .flatMap((c) => validateCapabilities(c, runner.capabilities).map((problem) => `${c.id}: ${problem}`));
if (capabilityProblems.length) throw new Error(`unsupported execution evidence:\n- ${capabilityProblems.join('\n- ')}`);
if (!Number.isInteger(Number(values.concurrency)) || Number(values.concurrency) < 1 || Number(values.concurrency) > 8) throw new Error('--concurrency must be an integer from 1 to 8');
if (values['dry-run']) {
  console.log(JSON.stringify({ suite: values.suite, client: runner.id, transport: 'acp', runs, ablation, plannedSessions: planned, policy: policySnapshot(cases.filter((c) => !caseId || c.id === caseId)) }, null, 2));
  process.exit(0);
}
if (!(approved >= planned && planned > 0)) {
  console.error(`approval gate: this run starts ${planned} live session(s); pass --approve-sessions ${planned} to proceed`);
  process.exit(4);
}
const pre = await runner.preflight(runnerOptions);
if (!pre.ok) {
  console.error(`preflight failed:\n- ${pre.problems.join('\n- ')}`);
  process.exit(1);
}

const ts = `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.suite}-${runner.id}`;
const outDir = join(config.outputDir, `${ts}-${command}`);
mkdirSync(outDir, { recursive: true });
const policy = archivePolicy(outDir, cases, { suite: values.suite, client: runner.id, transport: 'acp', model: values.model ?? null, command, runs, ablation, plannedSessions: planned, caseId: caseId ?? null });
const prepared = runner.prepare({
  outDir, skillName, skillSourceDir: skillDir, fixturesDir: existsSync(fixturesDir) ? fixturesDir : null, cases,
});
const { skillHash, canaryToken } = prepared;
const result = await runner.run(cases, { ...prepared, ...runnerOptions, outputDir: join(outDir, 'eval-output'), runs, ablation, caseId, concurrency: Number(values.concurrency) });
const normalized = { ...result, transport: 'acp', suite: values.suite, skillSha256: skillHash, canaryToken, command, runs, ablation, plannedSessions: planned, policySha256: policy.sha256 };
writeFileSync(join(outDir, 'normalized.json'), JSON.stringify(normalized, null, 2));
if (!smoke && result.cases?.length) {
  const { diff } = recordRun(config.resultsDir, values.suite, normalized);
  for (const d of diff) if (d.verdictChange || d.deltaChange) console.error(`diff ${d.id}: with ${d.withChange}, delta ${d.deltaChange}${d.verdictChange ? `, verdict ${d.verdictChange}` : ''}`);
}
console.log(JSON.stringify(normalized, null, 2));
process.exit(['passed', 'below_threshold'].includes(result.status) ? 0 : 2);
