import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { judgeArchivedRun, planJudgeRequests, storeAssessment } from './judge.mjs';
import { replayPolicy } from './policy.mjs';
import { assertCalibratedCases, scoreJudgedAnswers } from './judge-score.mjs';
import { reportRun } from './report.mjs';

function loadRubric(path) {
  const source = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() !== '.json') {
    if (!source.trim()) throw new Error('judge rubric must not be empty');
    return source;
  }
  const rubric = JSON.parse(source);
  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)
    || !Object.keys(rubric).length
    || Object.entries(rubric).some(([id, text]) => !/^[a-z0-9][a-z0-9-]*$/.test(id)
      || typeof text !== 'string' || !text.trim())) {
    throw new Error('JSON judge rubric must map case IDs to non-empty rubric strings');
  }
  return rubric;
}

export function archivedJudgeAnswers({ runDir, parse, requireReceipt = true, caseIds }) {
  const tracesDir = join(runDir, 'traces');
  if (!existsSync(tracesDir)) throw new Error(`no archived traces: ${runDir}`);
  const answers = [];
  for (const entry of readdirSync(tracesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || caseIds && !caseIds.includes(entry.name)) continue;
    for (const file of readdirSync(join(tracesDir, entry.name)).sort()) {
      const match = /^(with|without)-([1-9]\d*)\.jsonl$/.exec(file);
      if (!match) continue;
      const path = join(tracesDir, entry.name, file);
      const receiptPath = `${path}.receipt.json`;
      const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
      const valid = receipt
        ? receipt.valid === true && receipt.exitCode === 0 && !receipt.timedOut && !receipt.cancelled && !receipt.error
        : !requireReceipt;
      const transcript = parse(readFileSync(path, 'utf8'));
      answers.push({
        caseId: entry.name, arm: match[1], repetition: Number(match[2]),
        text: transcript.finalText, complete: transcript.complete === true,
        valid: valid && !(transcript.errors?.length),
      });
    }
  }
  if (caseIds?.some((id) => !answers.some((answer) => answer.caseId === id))) throw new Error('unknown or empty archived case filter');
  if (!answers.length) throw new Error(`no archived answers: ${runDir}`);
  return answers;
}

export async function judgeArchive({ runDir, parse, requireReceipt, caseIds, rubricPath, calibrationPath, model, client, approveSessions, timeoutMs, execute, dryRun = false }) {
  if (rubricPath && calibrationPath) throw new Error('calibrated scoring requires recorded Gherkin criteria, not --rubric');
  const rubric = rubricPath ? loadRubric(rubricPath) : undefined;
  const cases = rubricPath ? undefined : replayPolicy(runDir).cases;
  if (caseIds && typeof rubric === 'object' && caseIds.some((id) => !Object.hasOwn(rubric, id))) {
    throw new Error('selected case has no rubric in the JSON judge rubric');
  }
  const answers = archivedJudgeAnswers({ runDir, parse, requireReceipt, caseIds });
  if (cases && caseIds?.some((id) => !cases.find((c) => c.id === id)?.judgeCriteria?.length)) {
    throw new Error('selected case has no Gherkin judge criteria');
  }
  const plan = planJudgeRequests({ answers, rubric, cases, caseIds });
  const calibration = calibrationPath ? JSON.parse(readFileSync(calibrationPath, 'utf8')) : undefined;
  const selectedIds = new Set(answers.filter((answer) =>
    cases?.find((c) => c.id === answer.caseId)?.judgeCriteria?.length).map((answer) => answer.caseId));
  if (calibration) {
    assertCalibratedCases({
      calibration, cases: cases.filter((c) => selectedIds.has(c.id)), client, model, timeoutMs,
    });
  }
  if (dryRun) {
    const { plannedSessions, skipped } = plan;
    return { dryRun: true, client, model, plannedSessions, skipped };
  }
  const result = await judgeArchivedRun({
    answers, rubric, cases, model, client, approveSessions, timeoutMs,
    archiveDir: runDir, caseIds, ...(execute ? { execute } : {}),
  });
  if (calibration) {
    const report = reportRun(runDir, { includeAnswer: true, parse });
    report.cases = report.cases.filter((trace) => selectedIds.has(trace.caseId));
    const scoring = scoreJudgedAnswers({
      report, cases, assessments: result.assessments, calibration, client, model, timeoutMs,
    });
    const scorePath = await storeAssessment({ archiveDir: runDir, assessment: scoring });
    return { ...result, scoring, scorePath };
  }
  return result;
}
