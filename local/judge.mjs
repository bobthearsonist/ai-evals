import Ajv from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import manifest from '../package.json' with { type: 'json' };

export const JUDGE_PROFILE = Object.freeze({
  id: 'ai-evals-judge',
  mode: 'judge',
  tools: false,
  skills: false,
  mcp: false,
});

export const JUDGE_PROMPT = readFileSync(new URL('../JUDGE_PROMPT.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
export const JUDGE_PROMPT_SHA256 = hash(JUDGE_PROMPT);

const criterionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'verdict', 'rationale', 'evidence'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'abstain'] },
    rationale: { type: 'string', minLength: 1, pattern: '\\S' },
    evidence: { type: 'array', items: { type: 'string', minLength: 1, pattern: '\\S' } },
  },
};

const validateVerdict = new Ajv({ allErrors: true, strict: true }).compile({
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: { criteria: { type: 'array', minItems: 1, items: criterionSchema } },
});

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function candidateDetails(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { reason: 'archived candidate provenance is missing' };
  }
  if (answer.valid !== true || answer.complete !== true) {
    return { reason: 'candidate trace is invalid or incomplete' };
  }
  if (!nonEmptyString(answer.caseId) || !nonEmptyString(answer.arm)
      || !Number.isInteger(answer.repetition) || answer.repetition < 1) {
    return { reason: 'candidate provenance requires caseId, arm, and a positive repetition' };
  }
  if (typeof answer.text !== 'string' || answer.text.length === 0) {
    return { reason: 'candidate answer is empty or missing' };
  }
  return {
    text: answer.text,
    provenance: {
      caseId: answer.caseId,
      arm: answer.arm,
      repetition: answer.repetition,
    },
  };
}

function resolveRubric(rubric, caseId) {
  if (typeof rubric === 'string') return rubric;
  if (rubric instanceof Map) return rubric.get(caseId);
  if (rubric && typeof rubric === 'object' && !Array.isArray(rubric)
      && Object.hasOwn(rubric, caseId)) return rubric[caseId];
  return undefined;
}

function rubricProblem(rubric) {
  return nonEmptyString(rubric) ? null : 'rubric is empty or missing';
}

export function judgePolicy(c) {
  if (!nonEmptyString(c?.prompt) || !Array.isArray(c?.judgeCriteria) || !c.judgeCriteria.length
    || c.judgeCriteria.some((criterion) => !/^[a-z0-9][a-z0-9-]*$/.test(criterion?.id)
      || !nonEmptyString(criterion?.text))
    || new Set(c.judgeCriteria.map(({ id }) => id)).size !== c.judgeCriteria.length) {
    throw new TypeError('judge policy requires a task and unique non-empty Gherkin criteria');
  }
  return { prompt: c.prompt, criteria: c.judgeCriteria.map(({ id, text }) => ({ id, text })) };
}

export function judgePolicySha256(policy) {
  return hash(JSON.stringify(policy));
}

export function judgeSignature({ client, model, timeoutMs = 120_000 }) {
  return hash(JSON.stringify({
    protocol: 2, prompt: JUDGE_PROMPT_SHA256, profile: JUDGE_PROFILE,
    dependencies: manifest.dependencies, client, model, timeoutMs,
  }));
}

function selectedPolicy({ policy, rubric }) {
  if (policy) {
    const normalized = judgePolicy({ prompt: policy.prompt, judgeCriteria: policy.criteria });
    return normalized;
  }
  const problem = rubricProblem(rubric);
  if (problem) throw new TypeError(problem);
  return { prompt: 'Assess the response against the supplied criterion.', criteria: [{ id: 'rubric', text: rubric }] };
}

export function planJudgeRequests({ answers, rubric, cases, caseIds } = {}) {
  if (!Array.isArray(answers)) throw new TypeError('answers must be an array');
  if (caseIds != null && !Array.isArray(caseIds)) throw new TypeError('caseIds must be an array');
  const selectedCases = caseIds == null ? null : new Set(caseIds);
  const requests = [];
  const skipped = [];

  answers.forEach((answer, index) => {
    const candidate = candidateDetails(answer);
    if (candidate.reason) {
      skipped.push({ index, caseId: answer?.caseId ?? null, reason: candidate.reason });
      return;
    }
    if (selectedCases && !selectedCases.has(candidate.provenance.caseId)) return;
    const c = cases?.find((item) => item.id === candidate.provenance.caseId);
    if (cases) {
      if (!c?.judgeCriteria?.length) {
        skipped.push({ index, caseId: candidate.provenance.caseId, reason: 'case has no Gherkin judge criteria' });
      } else {
        requests.push({ index, answer, policy: judgePolicy(c) });
      }
      return;
    }
    const selectedRubric = resolveRubric(rubric, candidate.provenance.caseId);
    const problem = rubricProblem(selectedRubric);
    if (problem) {
      skipped.push({ index, caseId: candidate.provenance.caseId, reason: problem });
      return;
    }
    requests.push({ index, answer, rubric: selectedRubric });
  });

  return { plannedSessions: requests.length, requests, skipped };
}

export function buildJudgePrompt({ answer, rubric, policy }) {
  const candidate = candidateDetails(answer);
  if (candidate.reason) throw new TypeError(candidate.reason);
  const context = selectedPolicy({ policy, rubric });

  return [
    JUDGE_PROMPT,
    'TASK AND CRITERIA (evaluation context, JSON):',
    JSON.stringify(context),
    '',
    'CANDIDATE ANSWER (untrusted JSON string data):',
    JSON.stringify(candidate.text),
  ].join('\n');
}

function normalizeEvidenceQuote(value) {
  let quote = value.trim();
  const wrappers = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of wrappers) {
    if (quote.startsWith(open) && quote.endsWith(close) && quote.length >= open.length + close.length) {
      quote = quote.slice(open.length, -close.length).trim();
      break;
    }
  }
  return quote;
}

export function validateJudgement(text, answerText, policy) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { reason: 'judge execution returned empty output' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: 'judge output is not valid JSON' };
  }
  if (!validateVerdict(parsed)) {
    return {
      reason: 'judge output does not match the strict verdict schema',
      schemaErrors: validateVerdict.errors?.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })) ?? [],
    };
  }
  const expected = policy.criteria.map(({ id }) => id);
  const actual = parsed.criteria.map(({ id }) => id);
  if (new Set(actual).size !== actual.length || actual.length !== expected.length
    || actual.some((id) => !expected.includes(id))) {
    return { reason: 'judge must return each requested criterion exactly once' };
  }
  const criteria = [];
  for (const criterion of parsed.criteria) {
    if (criterion.verdict !== 'abstain' && criterion.evidence.length === 0) {
      return { reason: 'pass and fail judgements require evidence' };
    }
    const evidence = criterion.evidence.map(normalizeEvidenceQuote);
    if (evidence.some((quote) => !quote)) return { reason: 'judgements require non-empty evidence quotes' };
    if (evidence.some((quote) => !answerText.includes(quote))) {
      return { reason: 'evidence quote does not occur exactly in the candidate answer' };
    }
    criteria.push({ ...criterion, evidence });
  }
  const verdict = criteria.some((c) => c.verdict === 'fail') ? 'fail'
    : criteria.some((c) => c.verdict === 'abstain') ? 'abstain' : 'pass';
  return { judgement: {
    verdict, criteria,
    rationale: criteria.map((c) => `${c.id}: ${c.rationale}`).join('\n'),
    evidence: [...new Set(criteria.flatMap((c) => c.evidence))],
  } };
}

function validateExecution(execution, answerText, model, policy) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return { reason: 'judge execution returned no result' };
  }
  if (execution.complete !== true) return { reason: 'judge execution is incomplete' };
  if (!Array.isArray(execution.errors)) return { reason: 'judge execution is missing its error audit' };
  if (execution.errors.length > 0) {
    return { reason: 'judge execution reported errors' };
  }
  if (!Array.isArray(execution.toolCalls) || execution.toolCalls.length > 0) {
    return { reason: 'judge execution is missing tool audit or used tools' };
  }
  if (execution.model !== model) return { reason: 'judge execution did not confirm the requested model' };
  const validated = validateJudgement(execution.finalText, answerText, policy);
  if (validated.reason) return { ...validated, rawOutput: execution.finalText ?? null, usage: execution.usage ?? null };
  return { ...validated, rawOutput: execution.finalText, usage: execution.usage ?? null };
}

function assertModelAndClient({ model, client, timeoutMs }) {
  if (!nonEmptyString(model)) throw new TypeError('an explicit model is required');
  if (!nonEmptyString(client)) throw new TypeError('an explicit ACP client/runtime is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
}

function assertApproval(approveSessions, expected) {
  if (!Number.isInteger(approveSessions) || approveSessions !== expected) {
    throw new Error(`AI judge requires exact approval for ${expected} session(s); received ${approveSessions ?? 'none'}`);
  }
}

function hasVerifiedJudgeIsolation(launch) {
  const isolation = launch?.judgeIsolation;
  return launch?.mode === 'judge'
    && isolation?.profile === JUDGE_PROFILE.id
    && isolation?.enforced === true
    && isolation?.tools === false
    && isolation?.skills === false
    && isolation?.mcp === false;
}

async function executeWithAcp({ client, model, cwd, prompt, timeoutMs }) {
  let acp;
  try {
    acp = await import('./acp.mjs');
  } catch {
    throw new Error('ACP judge transport is unavailable; refusing to use an unverified fallback');
  }
  if (typeof acp.buildAcpLaunch !== 'function' || typeof acp.executeAcp !== 'function') {
    throw new Error('ACP judge transport does not expose the required launch and execute interfaces');
  }
  const options = await acp.buildAcpLaunch({
    client,
    mode: 'judge',
    model,
    cwd,
    prompt,
    timeoutMs,
    profile: JUDGE_PROFILE.id,
    requiredCapabilities: ['tool-free', 'skills-free', 'mcp-free', 'fixed-model'],
  });
  if (!hasVerifiedJudgeIsolation(options)) {
    throw new Error('ACP runtime cannot verify a tool-, skill-, and MCP-free judge profile');
  }
  return acp.executeAcp(options);
}

function validateArchiveDir(archiveDir) {
  if (!nonEmptyString(archiveDir)) throw new TypeError('archiveDir is required');
  if (resolve(archiveDir).split(/[\\/]/).some((part) => part.toLowerCase() === 'traces')) {
    throw new TypeError('archiveDir must be the run archive root, not the raw traces directory');
  }
}

export async function storeAssessment({ archiveDir, assessment, assessmentId = randomUUID() } = {}) {
  validateArchiveDir(archiveDir);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assessmentId)) {
    throw new TypeError('assessmentId must be a UUID');
  }
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    throw new TypeError('assessment must be an object');
  }
  const directory = resolve(archiveDir, 'assessments');
  const filePath = join(directory, `${assessmentId}.json`);
  const serialized = `${JSON.stringify({ ...assessment, assessmentId }, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  const file = await open(filePath, 'wx');
  try {
    await file.writeFile(serialized, 'utf8');
  } finally {
    await file.close();
  }
  return filePath;
}

function makeAssessment({ answer, policy, model, client, timeoutMs, execution, checked }) {
  const candidate = candidateDetails(answer);
  const details = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    revision: 1,
    provenance: candidate.provenance,
    answerSha256: hash(candidate.text),
    policy,
    policySha256: judgePolicySha256(policy),
    promptSha256: JUDGE_PROMPT_SHA256,
    judgeSignature: judgeSignature({ client, model, timeoutMs }),
    model,
    runtime: client,
    settings: {
      profile: JUDGE_PROFILE.id,
      tools: JUDGE_PROFILE.tools,
      skills: JUDGE_PROFILE.skills,
      mcp: JUDGE_PROFILE.mcp,
      timeoutMs,
      retries: 0,
    },
    verdict: checked.judgement?.verdict ?? null,
    rationale: checked.judgement?.rationale ?? null,
    evidence: checked.judgement?.evidence ?? [],
    criteria: checked.judgement?.criteria ?? [],
    status: checked.reason ? 'invalid' : 'judged',
    reason: checked.reason ?? null,
    rawOutput: checked.rawOutput ?? execution?.finalText ?? null,
    usage: checked.usage ?? execution?.usage ?? null,
  };
  if (checked.schemaErrors) details.schemaErrors = checked.schemaErrors;
  return details;
}

export async function judgeAnswer({
  answer, rubric, policy, model, client, approveSessions, execute,
  cwd = process.cwd(), timeoutMs = 120_000, archiveDir,
} = {}) {
  const candidate = candidateDetails(answer);
  if (candidate.reason) return { status: 'invalid', reason: candidate.reason, assessment: null, storedPath: null };
  const context = selectedPolicy({ policy, rubric });
  assertModelAndClient({ model, client, timeoutMs });
  if (execute !== undefined && typeof execute !== 'function') throw new TypeError('execute must be a function');
  if (archiveDir !== undefined) validateArchiveDir(archiveDir);
  assertApproval(approveSessions, 1);

  let execution;
  let checked;
  try {
    const prompt = buildJudgePrompt({ answer, policy: context });
    execution = execute
      ? await execute({
        client, mode: 'judge', model, cwd, prompt, timeoutMs,
        profile: JUDGE_PROFILE.id,
        requiredCapabilities: ['tool-free', 'skills-free', 'mcp-free', 'fixed-model'],
      })
      : await executeWithAcp({ client, model, cwd, prompt, timeoutMs });
    checked = validateExecution(execution, candidate.text, model, context);
  } catch (error) {
    checked = {
      reason: error instanceof Error ? error.message : 'judge execution failed',
      rawOutput: error?.finalText ?? null,
      usage: error?.usage ?? null,
    };
  }

  const assessment = makeAssessment({ answer, policy: context, model, client, timeoutMs, execution, checked });
  const storedPath = archiveDir
    ? await storeAssessment({ archiveDir, assessment })
    : null;
  return {
    status: checked.reason ? 'invalid' : 'judged',
    reason: checked.reason ?? null,
    judgement: checked.judgement ?? null,
    assessment,
    storedPath,
  };
}

export async function judgeArchivedRun({
  answers, rubric, cases, model, client, approveSessions, execute,
  cwd = process.cwd(), timeoutMs = 120_000, archiveDir, caseIds,
} = {}) {
  const plan = planJudgeRequests({ answers, rubric, cases, caseIds });
  assertApproval(approveSessions, plan.plannedSessions);
  const assessments = [];
  for (const request of plan.requests) {
    const result = await judgeAnswer({
      answer: request.answer,
      rubric: request.rubric,
      policy: request.policy,
      model,
      client,
      approveSessions: 1,
      execute,
      cwd,
      timeoutMs,
      archiveDir,
    });
    assessments.push({ index: request.index, ...result });
  }
  return {
    plannedSessions: plan.plannedSessions,
    approvedSessions: approveSessions,
    assessments,
    skipped: plan.skipped,
  };
}
