// Client-neutral transcript model and pure grader. Drivers turn a client's raw trace into a
// transcript; grading is then a deterministic function of (case, transcript, arm), so archived
// traces can be re-graded offline at no cost.

// transcript: { finalText, toolCalls: [{ name, input }], raw }
import { evaluateCheck } from './assertions.mjs';

// Returns { score, checks } with score = fraction of gradable checks passed.
// Adds the skill-trigger check (with-arm must call Skill when the case expects it; the
// without-arm must never) and the canary check.
export function gradeTranscript(c, transcript, { arm, canaryToken } = {}) {
  if (c.schemaVersion !== 2) throw new Error('only compiled schemaVersion 2 cases are supported');
  if (c.fixtures && transcript.transport === 'acp') {
    const reads = transcript.toolCalls.filter((call) =>
      ['Read', 'Glob', 'Grep', 'view', 'glob', 'grep', 'rg'].includes(call.name)
      || ['read', 'search'].includes(call.kind));
    const denied = (call) => /permission.*denied|denied because|not allowed|permission.*refused/i.test(JSON.stringify(call.rawOutput ?? call.content ?? ''));
    if (reads.some(denied) && !reads.some((call) => call.status === 'completed' && !denied(call))) {
      return { score: null, checks: [], invalid: true, errors: [{ name: 'fixture-inputs', diagnostic: 'fixture file reads were refused without any successful read' }] };
    }
  }
  const checks = c.checks.map((k) => evaluateCheck(k, transcript));
  const validToolEvidence = Array.isArray(transcript.toolCalls) &&
    transcript.toolCalls.every((call) => call && (typeof call.name === 'string'
      || (transcript.transport === 'acp' && call.name === undefined && ['read', 'search'].includes(call.kind))));
  const toolCalls = validToolEvidence ? transcript.toolCalls : [];
  const skillCalls = toolCalls.filter((t) => t.name === 'Skill').length;
  const triggerCheck = (passed) => !validToolEvidence
    ? { name: 'skill-trigger', passed: null, diagnostic: 'tool-call evidence is missing' }
    : { name: 'skill-trigger', passed };
  if (c.shouldTrigger) {
    if (arm === 'with') checks.push(triggerCheck(skillCalls >= 1));
  } else {
    checks.push(triggerCheck(skillCalls === 0));
  }
  if (canaryToken) {
    if (typeof transcript.raw !== 'string') {
      checks.push({ name: 'canary', passed: null, diagnostic: 'raw trace evidence is missing' });
    } else {
      checks.push({ name: 'canary', passed: !transcript.raw.includes(canaryToken) });
    }
  }
  const errors = checks.filter((check) => check.passed === null)
    .map((check) => ({ name: check.name, diagnostic: check.diagnostic ?? 'required evidence is missing' }));
  if (errors.length) return { score: null, checks, invalid: true, errors };
  const score = checks.length ? checks.filter((check) => check.passed).length / checks.length : null;
  return { score, checks, invalid: false, errors: [] };
}

// Separation-based verdict: with 3 runs per arm a mean delta alone is mostly noise, so a lift or
// regression is only claimed when every run of one arm beats every run of the other.
export function verdict(withScores, withoutScores) {
  if (!withScores?.length || !withoutScores?.length) return 'unmeasured';
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  if (Math.abs(mean(withScores) - mean(withoutScores)) < 0.05) return 'same';
  if (Math.min(...withScores) > Math.max(...withoutScores)) return 'lift';
  if (Math.max(...withScores) < Math.min(...withoutScores)) return 'regression';
  return 'inconclusive';
}
