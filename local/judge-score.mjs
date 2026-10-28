import { createHash } from 'node:crypto';
import { verdict } from './grade.mjs';
import { assessCalibration } from './judge-calibration.mjs';
import { judgePolicy, judgePolicySha256, validateJudgement } from './judge.mjs';

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function assertCalibratedCases({ calibration, cases, client, model, timeoutMs }) {
  const reliability = assessCalibration(calibration, { client, model, timeoutMs });
  if (!reliability.eligible) throw new Error(`judge calibration is not eligible for scoring: ${reliability.problems.join('; ')}`);
  for (const c of cases) {
    if (!reliability.policyHashes.includes(judgePolicySha256(judgePolicy(c)))) {
      throw new Error(`case ${c.id} is not covered by this judge calibration`);
    }
  }
  return reliability;
}

export function scoreJudgedAnswers({ report, cases, assessments, calibration, client, model, timeoutMs }) {
  const selectedCases = cases.filter((c) => report.cases.some((r) => r.caseId === c.id));
  const reliability = assertCalibratedCases({ calibration, cases: selectedCases, client, model, timeoutMs });
  const seen = new Set();
  const results = report.cases.map((trace) => {
    const c = selectedCases.find((item) => item.id === trace.caseId);
    if (!c) throw new Error(`scoring policy is missing case ${trace.caseId}`);
    const matches = assessments.filter(({ assessment }) => {
      const p = assessment?.provenance;
      return p?.caseId === trace.caseId && p.arm === trace.arm && p.repetition === trace.repetition;
    });
    const key = `${trace.caseId}/${trace.arm}/${trace.repetition}`;
    if (seen.has(key)) throw new Error(`duplicate trace ${key}`);
    seen.add(key);
    const assessment = matches[0]?.assessment;
    const policy = judgePolicy(c);
    const checked = assessment ? validateJudgement(assessment.rawOutput, trace.answer, policy) : null;
    const bound = matches.length === 1 && assessment?.schemaVersion === 2
      && assessment?.status === 'judged' && assessment?.runtime === client && assessment?.model === model
      && assessment?.judgeSignature === reliability.judgeSignature
      && assessment?.promptSha256 === calibration.promptSha256
      && assessment?.settings?.profile === 'ai-evals-judge'
      && assessment?.settings?.tools === false && assessment?.settings?.skills === false
      && assessment?.settings?.mcp === false && assessment?.settings?.retries === 0
      && assessment?.settings?.timeoutMs === (timeoutMs ?? 120_000)
      && assessment?.policySha256 === judgePolicySha256(policy)
      && typeof trace.answer === 'string'
      && assessment?.answerSha256 === createHash('sha256').update(trace.answer).digest('hex');
    const deterministicValid = Number.isFinite(trace.score) && trace.score >= 0 && trace.score <= 1;
    const valid = trace.valid && deterministicValid && bound && !checked?.reason && checked?.judgement.criteria.every((item) => item.verdict !== 'abstain');
    const semanticCriteria = valid ? checked.judgement.criteria.map((item) => ({
      name: `judge:${item.id}`, passed: item.verdict === 'pass', reason: item.rationale, evidence: item.evidence,
    })) : [];
    const semanticScore = valid ? Number(checked.judgement.verdict === 'pass') : null;
    const checks = [...trace.checks, ...(valid ? [{
      name: 'judge:aggregate', passed: semanticScore === 1,
      reason: 'Whole-answer semantic verdict; individual criteria are diagnostic only.',
    }] : [])];
    return {
      caseId: trace.caseId, arm: trace.arm, repetition: trace.repetition,
      valid: Boolean(valid), deterministicScore: trace.score,
      semanticScore, score: valid ? (trace.score + semanticScore) / 2 : null,
      invalidReason: valid ? null : trace.invalidReason ?? (!deterministicValid ? 'invalid deterministic score'
        : !bound ? 'missing, ambiguous or mismatched judge assessment' : checked?.reason ?? 'judge abstained'),
      checks, semanticCriteria,
    };
  });
  const summaries = selectedCases.map((c) => {
    const traces = results.filter((r) => r.caseId === c.id);
    const scores = (arm) => traces.filter((r) => r.arm === arm && r.valid).map((r) => r.score);
    const withRuns = scores('with');
    const withoutRuns = scores('without');
    const complete = traces.every((r) => r.valid);
    return {
      id: c.id, withRuns, withoutRuns,
      withScore: complete ? mean(withRuns) : null, withoutScore: complete ? mean(withoutRuns) : null,
      delta: complete && withRuns.length && withoutRuns.length ? mean(withRuns) - mean(withoutRuns) : null,
      verdict: complete ? verdict(withRuns, withoutRuns) : 'unmeasured',
      invalidRuns: traces.filter((r) => !r.valid).length,
    };
  });
  return {
    schemaVersion: 2, kind: 'calibrated-judge-score',
    weighting: 'equal weight for deterministic score and aggregate semantic verdict; criteria are diagnostic only',
    judgeSignature: reliability.judgeSignature, calibrationId: calibration.assessmentId ?? null,
    valid: results.length > 0 && results.every((r) => r.valid),
    overallScore: results.length > 0 && results.every((r) => r.valid) ? mean(results.filter((r) => r.arm === 'with').map((r) => r.score)) : null,
    cases: summaries, traces: results,
  };
}
