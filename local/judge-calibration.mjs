import { createHash } from 'node:crypto';
import {
  JUDGE_PROMPT_SHA256, judgeAnswer, judgePolicy, judgePolicySha256,
  judgeSignature, storeAssessment, validateJudgement,
} from './judge.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
export const CALIBRATION_GATE = Object.freeze({
  minimumSamples: 40,
  minimumPolicies: 5,
  minimumPerLabelPerPolicy: 4,
  requiredAccuracy: 1,
});

export function planCalibration({ cases, labels }) {
  if (labels?.schemaVersion !== 1 || !Array.isArray(labels.samples) || !labels.samples.length) {
    throw new Error('calibration labels require schemaVersion 1 and non-empty samples');
  }
  const ids = new Set();
  const texts = new Set();
  return labels.samples.map((sample) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sample?.id)
      || typeof sample?.caseId !== 'string'
      || typeof sample?.text !== 'string' || !sample.text.trim()
      || !['pass', 'fail'].includes(sample.expected)) {
      throw new Error('each calibration sample requires id, caseId, text and expected pass|fail');
    }
    if (ids.has(sample.id) || texts.has(sample.text.trim())) throw new Error('calibration sample IDs and answer texts must be unique');
    ids.add(sample.id);
    texts.add(sample.text.trim());
    const matches = cases.filter((c) => c.id === sample.caseId);
    if (matches.length !== 1) throw new Error(`calibration case must resolve uniquely: ${sample.caseId}`);
    return { sample, policy: judgePolicy(matches[0]) };
  });
}

export function assessCalibration(calibration, { client, model, timeoutMs = 120_000 } = {}) {
  if (calibration?.schemaVersion !== 1 || calibration.kind !== 'judge-calibration'
    || !Array.isArray(calibration.entries) || !calibration.entries.length) {
    throw new Error('invalid judge calibration artifact');
  }
  const signature = judgeSignature({ client, model, timeoutMs });
  if (calibration.judgeSignature !== signature || calibration.promptSha256 !== JUDGE_PROMPT_SHA256) {
    throw new Error('calibration does not match the current prompt, runtime, model or settings');
  }
  const problems = [];
  const policies = new Map();
  const ids = new Set();
  const texts = new Set();
  let correct = 0;
  for (const { sample, assessment } of calibration.entries) {
    if (!sample || !/^[a-z0-9][a-z0-9-]*$/.test(sample.id)
      || !['pass', 'fail'].includes(sample.expected)
      || typeof sample.text !== 'string' || !sample.text.trim()
      || ids.has(sample.id) || texts.has(sample.text.trim())) {
      throw new Error('invalid or duplicate calibration label');
    }
    ids.add(sample.id);
    texts.add(sample.text.trim());
    if (!assessment?.policy) throw new Error('calibration assessment policy is missing');
    const policy = judgePolicy({ prompt: assessment.policy.prompt, judgeCriteria: assessment.policy.criteria });
    const policyHash = judgePolicySha256(policy);
    const counts = policies.get(policyHash) ?? { caseId: sample.caseId, pass: 0, fail: 0 };
    counts[sample.expected]++;
    policies.set(policyHash, counts);
    const checked = validateJudgement(assessment.rawOutput, sample.text, policy);
    const bound = assessment.schemaVersion === 2 && assessment.status === 'judged'
      && assessment.judgeSignature === signature && assessment.promptSha256 === JUDGE_PROMPT_SHA256
      && assessment.runtime === client && assessment.model === model
      && assessment.policySha256 === policyHash && assessment.answerSha256 === hash(sample.text)
      && assessment.provenance?.caseId === sample.caseId
      && assessment.settings?.profile === 'ai-evals-judge'
      && assessment.settings?.tools === false && assessment.settings?.skills === false
      && assessment.settings?.mcp === false && assessment.settings?.retries === 0
      && assessment.settings?.timeoutMs === timeoutMs;
    if (bound && !checked.reason && checked.judgement.verdict === sample.expected
      && checked.judgement.criteria.every((c) => c.verdict !== 'abstain')) correct++;
    else problems.push(`sample ${sample.id}: ${!bound ? 'assessment provenance mismatch' : checked.reason ?? `expected ${sample.expected}, got ${checked.judgement.verdict}`}`);
  }
  if (ids.size < CALIBRATION_GATE.minimumSamples) problems.push(`at least ${CALIBRATION_GATE.minimumSamples} unique labeled answers required`);
  if (policies.size < CALIBRATION_GATE.minimumPolicies) problems.push(`at least ${CALIBRATION_GATE.minimumPolicies} distinct case policies required`);
  for (const counts of policies.values()) {
    if (counts.pass < CALIBRATION_GATE.minimumPerLabelPerPolicy || counts.fail < CALIBRATION_GATE.minimumPerLabelPerPolicy) {
      problems.push(`${counts.caseId}: at least ${CALIBRATION_GATE.minimumPerLabelPerPolicy} pass and fail labels each required`);
    }
  }
  return {
    eligible: problems.length === 0,
    samples: ids.size, correct, accuracy: correct / ids.size,
    policyHashes: [...policies.keys()], judgeSignature: signature, problems,
  };
}

export async function calibrateJudge({
  cases, labels, client, model, approveSessions, execute, archiveDir,
  timeoutMs = 120_000, dryRun = false,
}) {
  const requests = planCalibration({ cases, labels });
  if (dryRun) return { dryRun: true, plannedSessions: requests.length, gate: CALIBRATION_GATE };
  if (approveSessions !== requests.length) throw new Error(`calibration requires exact approval for ${requests.length} session(s)`);
  if (!archiveDir) throw new Error('calibration requires an archive directory');
  const entries = [];
  for (const { sample, policy } of requests) {
    const { assessment } = await judgeAnswer({
      answer: { caseId: sample.caseId, text: sample.text, arm: 'calibration', repetition: 1, valid: true, complete: true },
      policy, client, model, timeoutMs, execute, approveSessions: 1, archiveDir,
    });
    entries.push({ sample, assessment });
  }
  const calibration = {
    schemaVersion: 1, kind: 'judge-calibration', createdAt: new Date().toISOString(),
    promptSha256: JUDGE_PROMPT_SHA256, judgeSignature: judgeSignature({ client, model, timeoutMs }),
    client, model, timeoutMs, entries,
  };
  const reliability = assessCalibration(calibration, { client, model, timeoutMs });
  const storedPath = await storeAssessment({ archiveDir, assessment: { ...calibration, reliability } });
  return { plannedSessions: requests.length, calibration, reliability, storedPath };
}
