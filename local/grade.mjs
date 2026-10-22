// Client-neutral transcript model and pure grader. Drivers turn a client's raw trace into a
// transcript; grading is then a deterministic function of (case, transcript, arm), so archived
// traces can be re-graded offline at no cost.

// transcript: { finalText, toolCalls: [{ name, input }], raw }
import { evaluateCheck } from './assertions.mjs';

function gradeCheck(k, transcript, version2) {
  if (!version2) {
    const name = k.name ?? k.pattern ?? k.type;
    if (k.type === 'regex' || k.type === 'not_regex') {
      const hay = (k.target ?? 'last_message') === 'trace' ? transcript.raw : transcript.finalText;
      const hit = new RegExp(k.pattern, k.flags ?? '').test(hay);
      return { name, passed: k.type === 'regex' ? hit : !hit };
    }
    if (k.type === 'tool_order') {
      const idx = (toolName) => transcript.toolCalls.findIndex((call) => call.name === toolName);
      const before = idx(k.before);
      const after = idx(k.after);
      return { name, passed: before !== -1 && after !== -1 && before < after };
    }
    // file_exists needs a workdir snapshot, which ACP transcripts do not carry.
    return { name, passed: null, skipped: true };
  }
  const result = evaluateCheck(k, transcript);
  return result;
}

// Returns { score, checks } with score = fraction of gradable checks passed.
// Adds the skill-trigger check (with-arm must call Skill when the case expects it; the
// without-arm must never) and the canary check.
export function gradeTranscript(c, transcript, { arm, canaryToken } = {}) {
  if (c.fixtures && transcript.transport === 'acp') {
    const reads = transcript.toolCalls.filter((call) => ['Read', 'Glob', 'Grep', 'view', 'glob', 'rg'].includes(call.name));
    const denied = (call) => /permission.*denied|denied because|not allowed|permission.*refused/i.test(JSON.stringify(call.rawOutput ?? call.content ?? ''));
    if (reads.some(denied) && !reads.some((call) => call.status === 'completed' && !denied(call))) {
      return { score: null, checks: [], invalid: true, errors: [{ name: 'fixture-inputs', diagnostic: 'fixture file reads were refused without any successful read' }] };
    }
  }
  const version2 = c.schemaVersion === 2;
  const checks = c.checks.map((k) => gradeCheck(k, transcript, version2));
  const validToolEvidence = Array.isArray(transcript.toolCalls) &&
    transcript.toolCalls.every((call) => call && typeof call.name === 'string');
  const toolCalls = version2 && !validToolEvidence ? [] : transcript.toolCalls;
  const skillCalls = toolCalls.filter((t) => t.name === 'Skill').length;
  const triggerCheck = (passed) => version2 && !validToolEvidence
    ? { name: 'skill-trigger', passed: null, diagnostic: 'tool-call evidence is missing' }
    : { name: 'skill-trigger', passed };
  if (c.shouldTrigger) {
    if (arm === 'with') checks.push(triggerCheck(skillCalls >= 1));
  } else {
    checks.push(triggerCheck(skillCalls === 0));
  }
  if (canaryToken) {
    if (version2 && typeof transcript.raw !== 'string') {
      checks.push({ name: 'canary', passed: null, diagnostic: 'raw trace evidence is missing' });
    } else {
      checks.push({ name: 'canary', passed: !transcript.raw.includes(canaryToken) });
    }
  }
  if (c.schemaVersion === 2) {
    const errors = checks.filter((check) => check.passed === null)
      .map((check) => ({ name: check.name, diagnostic: check.diagnostic ?? 'required evidence is missing' }));
    if (errors.length) return { score: null, checks, invalid: true, errors };
    const score = checks.length ? checks.filter((check) => check.passed).length / checks.length : null;
    return { score, checks, invalid: false, errors: [] };
  }
  const graded = checks.filter((k) => k.passed !== null);
  const score = graded.length ? graded.filter((k) => k.passed).length / graded.length : null;
  return { score, checks };
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
