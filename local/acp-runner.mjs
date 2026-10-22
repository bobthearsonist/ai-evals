import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executeAcp } from './acp.mjs';
import { buildAcpLaunch } from './acp-profiles.mjs';
import { CLIENT_STATUS, makeRunResult, registerRunner, validateCapabilities } from './contract.mjs';
import { plannedSessions, prepareCopilot } from './copilot.mjs';
import { gradeTranscript, verdict } from './grade.mjs';

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function gradingTranscript(transcript) {
  return {
    ...transcript,
    transport: 'acp',
    raw: Array.isArray(transcript.raw) ? JSON.stringify(transcript.raw) : transcript.raw,
  };
}

export function parseAcpTrace(text) {
  const record = JSON.parse(text);
  if (record.type !== 'ai-evals.acp' || record.schemaVersion !== 1
    || typeof record.transcript?.finalText !== 'string'
    || !Array.isArray(record.transcript.toolCalls)
    || typeof record.transcript.complete !== 'boolean') throw new Error('invalid archived ACP transcript');
  return gradingTranscript(record.transcript);
}

// A custom profile is explicit operator configuration, never verified native isolation.
export function createAcpRunner({ client, exe, acpProfile, launch = buildAcpLaunch, execute = executeAcp } = {}) {
  if (!['claude', 'copilot', 'opencode'].includes(client)) throw new Error('unsupported ACP client');
  if (acpProfile !== undefined) {
    if (!acpProfile || typeof acpProfile !== 'object' || Array.isArray(acpProfile)
      || Object.keys(acpProfile).some((key) => !['command', 'args', 'env', 'sessionMeta', 'mcpServers'].includes(key))) {
      throw new Error('custom ACP profile accepts only command, args, env, sessionMeta and mcpServers');
    }
    acpProfile = structuredClone(acpProfile);
  }
  const build = (options) => launch({
    ...options,
    ...(acpProfile ? { ...acpProfile, client: 'custom', profile: 'custom' } : {}),
  });
  return registerRunner({
    id: client,
    transport: 'acp',
    capabilities: { hermetic: false, skillTrace: false, toolEvidence: true, traceEvidence: true, fileSnapshot: false, usageObservable: false, hardLimits: false, implemented: true },
    plannedSessions,
    prepare: prepareCopilot,
    parseTrace: parseAcpTrace,
    async preflight({ model, timeoutSeconds = 120 } = {}) {
      const problems = [];
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647) problems.push('invalid ACP timeout');
      if (typeof model !== 'string' || !model.trim() || model.toLowerCase() === 'auto') problems.push('ACP requires an explicit model, not auto');
      if (!problems.length) {
        try { build({
          client, mode: 'candidate', model, cwd: process.cwd(),
          prompt: 'ACP capability preflight; this prompt is never executed.',
          timeoutMs: timeoutSeconds * 1000, ...(exe ? { command: exe } : {}),
        }); }
        catch (error) { problems.push(error.message); }
      }
      return {
        ok: problems.length === 0, problems, transport: 'acp', profile: acpProfile ? 'custom' : client,
        capabilities: this.capabilities, isolation: 'not verified; non-hermetic',
        authentication: 'not checked; no model call made',
      };
    },
    async run(suite, options) {
      const {
        skillName, skillSnapshot, fixtureSnapshot, canaryToken, outputDir, model,
        runs, ablation, caseId, timeoutSeconds = 120,
      } = options;
      if (!Number.isInteger(runs) || runs < 1 || !['none', 'with-without'].includes(ablation)) throw new Error('invalid ACP schedule');
      const selected = suite.filter((c) => !caseId || c.id === caseId);
      if (!selected.length) throw new Error('no ACP cases selected');
      const problems = selected.flatMap((c) => [
        ...validateCapabilities(c, this.capabilities),
        ...(c.checks.some((check) => check.type === 'file_exists') ? ['file_exists requires fileSnapshot capability'] : []),
      ].map((problem) => `${c.id}: ${problem}`));
      if (problems.length) throw new Error(`unsupported ACP execution evidence: ${problems.join('; ')}`);
      const base = { client, transport: 'acp', model, outputDir, caveats: [
        'ACP is a protocol, not an OS sandbox or authentication boundary.',
        'Unknown usage/cost stays null; no hard spend guarantee.',
        ...(acpProfile ? ['Explicit custom ACP profile: ambient skills/MCP isolation is not verified.'] : []),
      ] };
      const preflight = await this.preflight({ model, timeoutSeconds });
      if (!preflight.ok) return makeRunResult({ ...base, status: CLIENT_STATUS.ERROR, caveats: [...base.caveats, ...preflight.problems] });
      mkdirSync(outputDir, { recursive: true });
      const receipts = [];
      let sessions = 0;
      let stopReason = null;
      jobs: for (const c of selected) for (let repeat = 1; repeat <= runs; repeat++) for (const arm of ablation === 'with-without' ? ['with', 'without'] : ['with']) {
        const workspace = mkdtempSync(join(outputDir, 'workspace-'));
        const dir = join(dirname(outputDir), 'traces', c.id);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${arm}-${repeat}.jsonl`);
        const receipt = { caseId: c.id, arm, repeat, started: false, valid: false, exitCode: null, error: null };
        try {
          const skillsRoot = join(workspace, '.github', 'skills');
          mkdirSync(skillsRoot, { recursive: true });
          if (arm === 'with') cpSync(skillSnapshot, join(skillsRoot, skillName), { recursive: true });
          const fixtures = join(workspace, 'fixtures');
          if (c.fixtures) cpSync(fixtureSnapshot, fixtures, { recursive: true });
          const launchOptions = build({
            client, mode: 'candidate', model, cwd: workspace, timeoutMs: timeoutSeconds * 1000,
            prompt: c.fixtures ? c.prompt.replaceAll('{{fixtures}}', fixtures) : c.prompt,
            ...(exe ? { command: exe } : {}),
          });
          receipt.started = true;
          sessions++;
          const captured = await execute(launchOptions);
          writeFileSync(path, JSON.stringify({ type: 'ai-evals.acp', schemaVersion: 1, transcript: captured }) + '\n', { flag: 'wx' });
          const transcript = gradingTranscript(captured);
          receipt.usage = transcript.usage ?? null;
          receipt.complete = transcript.complete;
          receipt.exitCode = 0;
          receipt.canaryTouched = transcript.raw?.includes(canaryToken) ?? false;
          if (!transcript.complete || transcript.errors?.length) throw new Error(transcript.errors?.join('; ') || 'ACP transcript incomplete');
          receipt.grade = gradeTranscript(c, transcript, { arm, canaryToken });
          if (receipt.grade.invalid || receipt.grade.score == null) throw new Error(
            receipt.grade.errors?.map((error) => error.diagnostic).join('; ') || 'required grading evidence unavailable',
          );
          receipt.valid = true;
        } catch (error) {
          receipt.error = error.message;
          stopReason = error.message;
        } finally {
          if (!existsSync(path)) writeFileSync(path, JSON.stringify({
            type: 'ai-evals.acp', schemaVersion: 1,
            transcript: { finalText: '', toolCalls: [], raw: '', complete: false, errors: [receipt.error] },
          }) + '\n', { flag: 'wx' });
          writeFileSync(`${path}.receipt.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
          receipts.push(receipt);
          rmSync(workspace, { recursive: true, force: true });
        }
        if (stopReason) break jobs;
      }
      const cases = selected.map((c) => {
        const records = receipts.filter((r) => r.caseId === c.id);
        const scores = (arm) => records.filter((r) => r.valid && r.arm === arm).map((r) => r.grade.score);
        const withRuns = scores('with');
        const withoutRuns = scores('without');
        return {
          id: c.id, withRuns, withoutRuns, withScore: mean(withRuns), withoutScore: mean(withoutRuns),
          delta: mean(withRuns) != null && mean(withoutRuns) != null ? mean(withRuns) - mean(withoutRuns) : null,
          verdict: verdict(withRuns, withoutRuns), invalidRuns: records.filter((r) => !r.valid).length,
          partial: records.length !== runs * (ablation === 'with-without' ? 2 : 1) || records.some((r) => !r.valid),
          partialReason: stopReason, costUsd: null,
        };
      });
      const overallScore = mean(cases.flatMap((c) => c.withRuns));
      return makeRunResult({
        ...base, cases, sessions, overallScore, costUsd: null, canaryTouched: receipts.some((receipt) => receipt.canaryTouched),
        status: stopReason ? sessions ? CLIENT_STATUS.PARTIAL : CLIENT_STATUS.ERROR
          : overallScore === 1 ? CLIENT_STATUS.PASSED : CLIENT_STATUS.BELOW_THRESHOLD,
        caveats: stopReason ? [...base.caveats, stopReason] : base.caveats,
      });
    },
  });
}
