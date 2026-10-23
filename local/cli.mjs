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
import { reportRun, renderReport } from './report.mjs';

try {
if (process.argv[2] === 'run-all') {
  process.argv.splice(2, 1);
  await import('./run-all.mjs');
  process.exit(process.exitCode ?? 0);
}
if (process.argv.some((a) => a === '--runners' || a.startsWith('--runners='))
  && !['validate', 'regrade', 'judge', 'report', 'migrate'].includes(process.argv[2])) {
  await import('./run-all.mjs');
  process.exit(process.exitCode ?? 0);
}
if (process.argv.includes('--help') || !process.argv[2]) {
  console.log(`usage: ai-evals <validate|preflight|smoke|run|run-all|regrade|judge|report|migrate> [arguments]\n\nCommands:\n  validate --suite NAME                 Validate cases and policy offline\n  preflight --client ID --model ID      Check ACP readiness without inference\n  smoke --suite NAME [--case ID ...]    Run selected cases once, with skill\n  run --suite NAME [--runs N]            Run paired with/without evaluation\n  run-all [--suite NAME | --suites A,B] Run selected suites and clients\n  regrade RUN_DIR                        Regrade archived traces offline\n  judge RUN_DIR --client ID --model ID  Assess archived answers (requires --rubric)\n  report RUN_DIR [--answer]              Show per-trace checks and Skill calls\n  migrate SRC_DIR --out DIR              Convert JSON cases to Gherkin\n\nCommon flags: --config PATH --cases-dir PATH --skill-root ROOTS --output-dir PATH --results-dir PATH\n              --client ID | --runners ID[,ID] --model ID --exe PATH --timeout-seconds N --json\n              --dry-run --approve-sessions N --acp-profile PATH\nRun flags: --suite NAME --case ID (repeatable for smoke) --runs N --concurrency 1..8\nrun-all flags: --suites A,B --claude-model ID --copilot-model ID --opencode-model ID\n              --claude-exe PATH --copilot-exe PATH --opencode-exe PATH\n              --claude-acp-profile PATH --copilot-acp-profile PATH\nRegrade flags: --policy recorded|current --suite NAME\nJudge flags: --rubric PATH --case ID (repeatable) --approve-sessions N --dry-run\nReport flag: --answer; migrate flag: --out DIR\nExit codes: 0 success; 1 evaluation/preflight failure or below threshold; 2 usage/config/approval error.`);
  process.exit(0);
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    client: { type: 'string' },
    suite: { type: 'string' },
    runs: { type: 'string' },
    case: { type: 'string', multiple: true },
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
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    answer: { type: 'boolean', default: false },
  },
});

const command = positionals[0];
if (command === 'migrate') {
  if (positionals.length !== 2 || !values.out) throw new Error('usage: ai-evals migrate <srcDir> --out <dir>');
  const { migrateJsonCases } = await import('./migrate.mjs');
  const converted = migrateJsonCases(resolve(positionals[1]));
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'cases.feature'), converted.feature);
  for (const sample of converted.samples) {
    if (sample.fileName !== resolve(sample.fileName).split(/[\\/]/).at(-1)) throw new Error(`invalid migration sample filename: ${sample.fileName}`);
    writeFileSync(join(outDir, sample.fileName), typeof sample.content === 'string'
      ? sample.content : `${JSON.stringify(sample.content, null, 2)}\n`);
  }
  if (values.json) console.log(JSON.stringify({ outDir, samples: converted.samples.map((sample) => sample.fileName), warnings: converted.warnings }, null, 2));
  else console.log(`migrated ${converted.samples.length} case(s) to ${outDir}${converted.warnings.length ? `\nWarnings:\n- ${converted.warnings.join('\n- ')}` : ''}`);
  process.exit(0);
}
if (command === 'report') {
  if (positionals.length !== 2) throw new Error('usage: ai-evals report <runDir> [--answer] [--json]');
  const result = reportRun(resolve(positionals[1]), { includeAnswer: values.answer });
  console.log(values.json ? JSON.stringify(result, null, 2) : renderReport(result));
  process.exit(0);
}
if (values.answer && command !== 'report') throw new Error('--answer is only supported by report');
if (values.out && command !== 'migrate') throw new Error('--out is only supported by migrate');
const config = resolveConfig({ configPath: values.config, flags: { skillRoot: values['skill-root'], casesDir: values['cases-dir'], outputDir: values['output-dir'], resultsDir: values['results-dir'] } });
const SKILL_ROOTS = config.skillsRoots;
const findSkill = (name) => SKILL_ROOTS.map((r) => join(r, name)).find((p) => existsSync(join(p, 'SKILL.md')));
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
    caseIds: values.case?.length ? values.case : undefined, rubricPath: values.rubric && resolve(values.rubric),
    model: values.model, client: values.client, approveSessions: Number(values['approve-sessions'] ?? 0), timeoutMs, dryRun: values['dry-run'],
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.dryRun ? 0 : result.assessments.length > 0 && result.assessments.every((assessment) => assessment.judgement?.verdict === 'pass') ? 0 : 1);
}
const runnerOptions = {
  model: values.model,
  timeoutSeconds: Number(values['timeout-seconds'] ?? 120),
};

if (!runner.capabilities.implemented && !['validate', 'regrade'].includes(command) && !values['dry-run']) {
  throw new Error(`${runner.id}: not implemented`);
}
if (command === 'preflight') {
  const r = await runner.preflight(runnerOptions);
  console.log(JSON.stringify({ transport: 'acp', ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (!['smoke', 'run', 'regrade', 'validate'].includes(command)) throw new Error('unknown command or invalid command arguments');

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
  if (values.json) console.log(JSON.stringify({ policy: policy.mode, policySha256: policy.sha256, assessment: path, cases: out }, null, 2));
  else {
    for (const c of out) console.log(`${c.id}: with=${c.withScore?.toFixed(2)} without=${c.withoutScore?.toFixed(2)} [${c.verdict}]${c.invalidRuns ? ' invalid=' + c.invalidRuns : ''}`);
    console.log(`policy=${policy.mode} sha256=${policy.sha256} assessment=${path}`);
  }
  process.exit(0);
}
if (!values.suite) throw new Error('--suite is required');
const { skill: skillName, casesFolder } = suiteSettings(config, values.suite);
const suiteDir = join(config.casesDir, casesFolder);
const cases = loadSuite(suiteDir);
const fixturesDir = join(suiteDir, 'fixtures');
if (command === 'validate') {
  const result = { suite: values.suite, caseCount: cases.length, policy: policySnapshot(cases) };
  console.log(values.json ? JSON.stringify(result, null, 2) : `${values.suite}: valid (${cases.length} cases, policy ${result.policy.sha256.slice(0, 12)})`);
  process.exit(0);
}
const skillDir = findSkill(skillName);
if (!skillDir) {
  throw new Error(`skill "${skillName}" not found under: ${SKILL_ROOTS.join('; ')}`);
}
const smoke = command === 'smoke';
const requestedCaseIds = values.case ?? [];
if (!smoke && requestedCaseIds.length > 1) throw new Error('--case may be repeated only for smoke');
const selectedCaseIds = smoke ? (requestedCaseIds.length ? requestedCaseIds : [cases[0].id]) : requestedCaseIds;
if (new Set(selectedCaseIds).size !== selectedCaseIds.length) throw new Error('--case values must be distinct');
const caseId = selectedCaseIds[0];
const runs = smoke ? 1 : Number(values.runs ?? 3);
const ablation = smoke ? 'none' : 'with-without';
const planned = runner.plannedSessions({ caseCount: smoke ? selectedCaseIds.length : caseId ? 1 : cases.length, runs, ablation });
const approved = Number(values['approve-sessions'] ?? 0);

if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
for (const id of selectedCaseIds) if (!cases.some((c) => c.id === id)) throw new Error(`unknown case: ${id}`);
const selectedSet = new Set(selectedCaseIds);
const capabilityProblems = cases.filter((c) => selectedSet.size ? selectedSet.has(c.id) : true)
  .flatMap((c) => validateCapabilities(c, runner.capabilities).map((problem) => `${c.id}: ${problem}`));
if (capabilityProblems.length) throw new Error(`unsupported execution evidence:\n- ${capabilityProblems.join('\n- ')}`);
if (!Number.isInteger(Number(values.concurrency)) || Number(values.concurrency) < 1 || Number(values.concurrency) > 8) throw new Error('--concurrency must be an integer from 1 to 8');
if (values['dry-run']) {
  const result = { suite: values.suite, client: runner.id, transport: 'acp', runs, ablation, plannedSessions: planned, policy: policySnapshot(cases.filter((c) => selectedSet.size ? selectedSet.has(c.id) : true)) };
  console.log(values.json ? JSON.stringify(result, null, 2) : `${values.suite}: dry run; ${selectedSet.size || cases.length} case(s), ${planned} session(s) planned`);
  process.exit(0);
}
if (!(approved >= planned && planned > 0)) throw new Error(`approval gate: this run starts ${planned} live session(s); pass --approve-sessions ${planned} to proceed`);
const pre = await runner.preflight(runnerOptions);
if (!pre.ok) {
  console.error(`error: preflight failed:\n- ${pre.problems.join('\n- ')}`);
  process.exit(1);
}

const ts = `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.suite}-${runner.id}`;
const outDir = join(config.outputDir, `${ts}-${command}`);
mkdirSync(outDir, { recursive: true });
const policy = archivePolicy(outDir, cases, { suite: values.suite, client: runner.id, transport: 'acp', model: values.model ?? null, command, runs, ablation, plannedSessions: planned, caseId: caseId ?? null, caseIds: smoke ? selectedCaseIds : undefined });
const prepared = runner.prepare({
  outDir, skillName, skillSourceDir: skillDir, fixturesDir: existsSync(fixturesDir) ? fixturesDir : null, cases,
});
const { skillHash, canaryToken } = prepared;
const singleResults = [];
for (const id of smoke && selectedCaseIds.length > 1 ? selectedCaseIds : [caseId]) {
  singleResults.push(await runner.run(cases, { ...prepared, ...runnerOptions, outputDir: join(outDir, 'eval-output'), runs, ablation, caseId: id, concurrency: Number(values.concurrency) }));
  if (!['passed', 'below_threshold'].includes(singleResults.at(-1).status)) break;
}
const result = singleResults.length === 1 ? singleResults[0] : {
  ...singleResults[0],
  cases: singleResults.flatMap((item) => item.cases ?? []),
  sessions: singleResults.reduce((sum, item) => sum + (item.sessions ?? 0), 0),
  overallScore: singleResults.flatMap((item) => item.cases ?? []).reduce((sum, item, _, all) => sum + (item.withScore ?? 0) / all.length, 0),
  status: singleResults.some((item) => !['passed', 'below_threshold'].includes(item.status)) ? 'partial'
    : singleResults.every((item) => item.status === 'passed') ? 'passed' : 'below_threshold',
};
const normalized = { ...result, transport: 'acp', suite: values.suite, skillSha256: skillHash, canaryToken, command, runs, ablation, plannedSessions: planned, policySha256: policy.sha256 };
writeFileSync(join(outDir, 'normalized.json'), JSON.stringify(normalized, null, 2));
if (!smoke && result.cases?.length) {
  const { diff } = recordRun(config.resultsDir, values.suite, normalized);
  for (const d of diff) if (d.verdictChange || d.deltaChange) console.error(`diff ${d.id}: with ${d.withChange}, delta ${d.deltaChange}${d.verdictChange ? `, verdict ${d.verdictChange}` : ''}`);
}
if (values.json) console.log(JSON.stringify(normalized, null, 2));
else {
  console.log(`${values.suite}: ${result.status} client=${runner.id} cases=${result.cases?.length ?? 0} score=${result.overallScore?.toFixed?.(2) ?? '-'} sessions=${result.sessions ?? 0}`);
  for (const c of result.cases ?? []) console.log(`  ${c.id}: score=${c.withScore?.toFixed(2) ?? '-'} [${c.verdict}]${c.invalidRuns ? ` (${c.invalidRuns} invalid run(s))` : ''}`);
}
process.exit(['passed'].includes(result.status) ? 0 : 1);

} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
