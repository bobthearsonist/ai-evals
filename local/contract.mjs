// Client-neutral contract for local ACP eval runners.
// Adapters declare capabilities honestly; results are always labelled non-hermetic.

import { validateV2CheckSchema, validateV2CaseSchema } from './schema.mjs';
import { evaluateCheck } from './assertions.mjs';

export const RESULT_LABEL = 'acp-non-hermetic';

export const CLIENT_STATUS = Object.freeze({
  PASSED: 'passed',
  BELOW_THRESHOLD: 'below_threshold',
  PARTIAL: 'partial',
  AUTH_FAILED: 'auth_failed',
  ERROR: 'error',
  NOT_IMPLEMENTED: 'not_implemented',
});

export function makeRunResult(partial = {}) {
  return {
    client: 'unknown',
    transport: 'acp',
    label: RESULT_LABEL,
    status: CLIENT_STATUS.ERROR,
    clientVersion: null,
    sessions: 0,
    overallScore: null,
    costUsd: null,
    cases: [],
    canaryTouched: false,
    caveats: [],
    outputDir: null,
    ...partial,
  };
}

const registry = new Map();

// A runner provides: id, capabilities {hermetic,skillTrace,usageObservable,hardLimits,implemented},
// preflight(ctx), plannedSessions(suite, opts), run(suite, opts) -> RunResult.
export function registerRunner(runner) {
  if (!runner?.id || typeof runner.run !== 'function' || typeof runner.preflight !== 'function') {
    throw new TypeError('runner must define id, preflight() and run()');
  }
  if (!runner.capabilities || runner.capabilities.hermetic !== false) {
    throw new TypeError(`runner ${runner.id} must declare capabilities.hermetic === false`);
  }
  registry.set(runner.id, runner);
  return runner;
}

export function getRunner(id) {
  const runner = registry.get(id);
  if (!runner) throw new Error(`unknown client "${id}"; registered: ${[...registry.keys()].join(', ')}`);
  return runner;
}

export function listRunners() {
  return [...registry.values()];
}

// Neutral suite case shared by every adapter.
export function validateCase(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['case must be an object'];
  if (c.schemaVersion === 2) return validateV2Case(c);
  if (c.schemaVersion !== undefined && c.schemaVersion !== 1) problems.push(`unsupported schemaVersion ${c.schemaVersion}; this harness reads 1 or 2`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id ?? '')) problems.push('id must be kebab-case');
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) problems.push('prompt required');
  if (typeof c.shouldTrigger !== 'boolean') problems.push('shouldTrigger must be boolean');
  if (!Array.isArray(c.checks) || c.checks.length === 0) problems.push('checks must be a non-empty array');
  if (c.fixtures !== undefined && typeof c.fixtures !== 'boolean') problems.push('fixtures must be boolean');
  if (c.samples !== undefined) {
    const s = c.samples;
    if (!s || !Array.isArray(s.pass) || !Array.isArray(s.fail) || ![...s.pass, ...s.fail].every((x) => typeof x === 'string')) problems.push('samples must be { pass: string[], fail: string[] }');
  }
  for (const [index, check] of (Array.isArray(c.checks) ? c.checks : []).entries()) {
    const name = typeof check?.name === 'string' ? ` (${check.name})` : '';
    const label = `checks[${index}]${name}`;
    if (!check || typeof check !== 'object') {
      problems.push(`${label}: check must be an object`);
      continue;
    }
    if (!['regex', 'not_regex', 'file_exists', 'tool_order'].includes(check.type)) problems.push(`${label}: unsupported check type ${check.type}`);
    if (['regex', 'not_regex'].includes(check.type) && typeof check.pattern !== 'string') problems.push(`${label}: check needs pattern`);
    if (check.type === 'file_exists' && typeof check.path !== 'string') problems.push(`${label}: file_exists needs path`);
    if (check.type === 'tool_order' && (typeof check.before !== 'string' || typeof check.after !== 'string')) problems.push(`${label}: tool_order needs before and after`);
  }
  return problems;
}

// Version 2 is deliberately stricter than the legacy v1 contract. Keep the v1
// checks above unchanged so archived suites retain their historical validation.
export function validateV2Case(c) {
  const problems = validateV2CaseSchema(c).map((problem) => {
    const match = /^\/checks\/(\d+)(.*)$/.exec(problem);
    if (!match) return problem;
    const check = c?.checks?.[Number(match[1])];
    const name = typeof check?.name === 'string' ? ` (${check.name})` : '';
    return `checks[${match[1]}]${name}${match[2]}`;
  });
  if (!Array.isArray(c?.checks)) return problems;
  const names = new Set();
  for (const [index, check] of c.checks.entries()) {
    const label = typeof check?.name === 'string' ? `checks[${index}] (${check.name})` : `checks[${index}]`;
    for (const problem of validateCheck(check)) {
      if (problem.startsWith('invalid regular expression:')) problems.push(`${label}: ${problem}`);
    }
    if (typeof check?.name === 'string') {
      if (names.has(check.name)) problems.push(`${label}: duplicate check name "${check.name}"`);
      names.add(check.name);
    }
  }
  return problems;
}

export function validateCheck(check) {
  return validateV2CheckSchema(check);
}

// This is a preflight policy helper. A runner should call it before scheduling
// paid sessions, rather than allowing a transcript grader to skip unavailable evidence.
export function validateCapabilities(c, capabilities = {}) {
  const problems = [];
  if (c?.schemaVersion !== 2) return problems;
  for (const [index, check] of (Array.isArray(c.checks) ? c.checks : []).entries()) {
    if (check?.type === 'file_exists' && capabilities.fileSnapshot !== true) {
      problems.push(`checks[${index}] (${check.name}): file_exists requires fileSnapshot capability`);
    }
    if (check?.type === 'tool_order' && capabilities.toolEvidence !== true) {
      problems.push(`checks[${index}] (${check.name}): tool_order requires toolEvidence capability`);
    }
    if (check?.target === 'trace' && capabilities.traceEvidence !== true) {
      problems.push(`checks[${index}] (${check.name}): trace target requires traceEvidence capability`);
    }
  }
  return problems;
}

// Applies a case's text checks to a hand-written answer; used to validate graders against known samples.
export function gradeSample(c, text) {
  const failed = [];
  if (c.schemaVersion === 2) {
    const transcript = typeof text === 'string' ? { finalText: text } : text;
    const checks = c.checks.map((check) => evaluateCheck(check, transcript));
    const errors = checks.filter((check) => check.passed === null)
      .map((check) => ({ name: check.name, diagnostic: check.diagnostic ?? 'required evidence is missing' }));
    return {
      passed: errors.length === 0 && checks.every((check) => check.passed),
      failed: checks.filter((check) => check.passed === false).map((check) => check.name),
      ...(errors.length ? { invalid: true, errors } : { invalid: false, errors: [] }),
    };
  }
  for (const k of c.checks) {
    if (k.type !== 'regex' && k.type !== 'not_regex') continue;
    const hit = new RegExp(k.pattern, k.flags ?? '').test(text);
    if (k.type === 'regex' ? !hit : hit) failed.push(k.name ?? k.pattern);
  }
  return { passed: failed.length === 0, failed };
}
