import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gradeTranscript } from './grade.mjs';
import { parseAcpTrace } from './acp-runner.mjs';
import { replayPolicy } from './policy.mjs';

function checkCondition(definition) {
  const target = { trace: 'trace', commit_subject: 'commit subject', last_message: 'response' }[definition.target ?? 'last_message'] ?? 'response';
  switch (definition.type) {
    case 'contains': return `${target} to contain ${JSON.stringify(definition.value)}`;
    case 'not_contains': return `${target} not to contain ${JSON.stringify(definition.value)}`;
    case 'starts_with': return `${target} to start with ${JSON.stringify(definition.value)}`;
    case 'regex': return `${target} to match /${definition.pattern}/${definition.flags ?? ''}`;
    case 'not_regex': return `${target} not to match /${definition.pattern}/${definition.flags ?? ''}`;
    case 'max_length': return `${target} to be at most ${definition.limit} characters`;
    case 'length_less_than': return `${target} to be shorter than ${definition.limit} characters`;
    case 'conventional_header': return `commit subject to use type ${definition.types.join(', ')}`;
    case 'lowercase_initial': return 'commit description to start with a lowercase letter';
    case 'tool_order': return `tools ${definition.before} then ${definition.after}`;
    case 'file_exists': return `file ${definition.path} to exist`;
    default: return JSON.stringify(definition);
  }
}
function receiptStatus(path) {
  const receiptPath = `${path}.receipt.json`;
  if (!existsSync(receiptPath)) return { valid: false, reason: 'run receipt is missing' };
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const valid = receipt.valid === true && receipt.exitCode === 0
    && !receipt.timedOut && !receipt.cancelled && !receipt.error;
  return { valid, reason: valid ? null : receipt.error ?? 'run receipt is invalid' };
}

export function reportRun(runDir, { includeAnswer = false, parse = parseAcpTrace } = {}) {
  const metadata = JSON.parse(readFileSync(join(runDir, 'normalized.json'), 'utf8'));
  const cases = replayPolicy(runDir).cases;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const tracesDir = join(runDir, 'traces');
  if (!existsSync(tracesDir)) throw new Error(`no archived traces: ${runDir}`);
  const results = [];

  for (const entry of readdirSync(tracesDir, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const caseId = entry.name;
    const caseDefinition = byId.get(caseId);
    if (!caseDefinition) continue;
    const directory = join(tracesDir, caseId);
    for (const filename of readdirSync(directory).sort()) {
      const match = /^(with|without)-([1-9]\d*)\.jsonl$/.exec(filename);
      if (!match) continue;
      const tracePath = join(directory, filename);
      const transcript = parse(readFileSync(tracePath, 'utf8'));
      const receipt = receiptStatus(tracePath);
      const grade = gradeTranscript(caseDefinition, transcript, {
        arm: match[1], canaryToken: metadata.canaryToken,
      });
      const skillCalls = transcript.toolCalls.filter((call) => call.name === 'Skill').length;
      const definitions = new Map(caseDefinition.checks.map((check) => [check.name ?? check.pattern ?? check.type, check]));
      results.push({
        caseId,
        arm: match[1],
        repetition: Number(match[2]),
        complete: transcript.complete === true,
        valid: receipt.valid && transcript.complete === true && !transcript.errors?.length && !grade.invalid && grade.score != null,
        invalidReason: receipt.reason ?? (transcript.errors?.length ? transcript.errors.join('; ') : null)
          ?? (!transcript.complete ? 'transcript is incomplete' : null)
          ?? (grade.invalid ? grade.errors?.map((error) => error.diagnostic).join('; ') : null)
          ?? (grade.score == null ? 'no gradable checks' : null),
        score: grade.score,
        skillLoaded: skillCalls > 0,
        skillCalls,
        checks: grade.checks.map((check) => {
          const definition = definitions.get(check.name);
          const condition = definition ? checkCondition(definition)
            : check.name === 'skill-trigger' ? `Skill calls: expected ${caseDefinition.shouldTrigger && match[1] === 'with' ? 'at least one' : 'none'}; observed ${skillCalls}`
              : check.name === 'canary' ? 'canary token absent from the raw trace' : 'required check evidence';
          return {
            name: check.name,
            passed: check.passed,
            reason: check.diagnostic ?? `${check.passed === true ? 'matched' : check.passed === false ? 'expected' : 'could not verify'} ${condition}`,
          };
        }),
        ...(includeAnswer ? { answer: transcript.finalText } : {}),
      });
    }
  }
  if (!results.length) throw new Error(`no archived traces: ${runDir}`);
  return { runDir, suite: metadata.suite ?? null, client: metadata.client ?? null, cases: results };
}

export function renderReport(report) {
  const lines = [
    `Report: ${report.suite ?? 'unknown suite'} (${report.client ?? 'unknown client'})`,
    '',
    '| Case | Trace | Validity | Skill loaded | Check | Result | Reason |',
    '|---|---|---|---|---|---|---|',
  ];
  const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
  for (const result of report.cases) {
    const trace = `${result.arm}-${result.repetition}`;
    const validity = result.valid ? 'valid' : `invalid: ${result.invalidReason ?? 'incomplete evidence'}`;
    const skill = `${result.skillLoaded ? 'yes' : 'no'} (${result.skillCalls})`;
    if (!result.checks.length) {
      lines.push(`| ${cell(result.caseId)} | ${trace} | ${cell(validity)} | ${skill} | - | INVALID | no check results |`);
    }
    for (const check of result.checks) {
      const status = check.passed === true ? 'PASS' : check.passed === false ? 'FAIL' : 'INVALID';
      lines.push(`| ${cell(result.caseId)} | ${trace} | ${cell(validity)} | ${skill} | ${cell(check.name)} | ${status} | ${cell(check.reason)} |`);
    }
    if (result.answer !== undefined) lines.push('', `Answer (${result.caseId}/${trace}):`, result.answer);
  }
  return `${lines.join('\n')}\n`;
}
