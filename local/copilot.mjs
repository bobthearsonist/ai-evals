import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_STATUS, makeRunResult, registerRunner, validateCase } from './contract.mjs';
import { hashTree } from './compile-claude.mjs';
import { gradeTranscript, verdict } from './grade.mjs';
import { createAcpRunner } from './acp-runner.mjs';

const REQUIRED_FLAGS = [
  '--prompt', '--output-format', '--model', '--no-ask-user', '--no-custom-instructions',
  '--disable-builtin-mcps', '--no-auto-update', '--available-tools', '--allow-tool',
  '--max-ai-credits', '--usage-output-file', '--trust-folder',
  '--disallow-temp-dir',
];
const PARSED_EVENTS = new Set([
  'assistant.message', 'assistant.turn_start', 'user.message', 'tool.execution_start',
  'tool.execution_complete', 'skill.invoked', 'session.skills_loaded',
  'session.idle', 'session.error', 'session.shutdown', 'abort', 'result',
]);
const mean = (a) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const read = (p) => readFileSync(p, 'utf8');
const json = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

// Only these public session-event fields are interpreted. The original JSONL is never rewritten.
export function parseCopilotTrace(text) {
  const t = { finalText: '', toolCalls: [], raw: String(text), complete: false, errors: [], skillInvocations: [], runtimeSkills: null };
  const calls = [];
  let idle = false;
  for (const [i, line] of t.raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch {
      t.errors.push(`invalid JSON at line ${i + 1}`);
      continue;
    }
    if (!isObject(ev) || typeof ev.type !== 'string') {
      t.errors.push(`invalid event envelope at line ${i + 1}`);
      continue;
    }
    if (!PARSED_EVENTS.has(ev.type)) continue;
    if (ev.type === 'result') {
      if (ev.agentId || ev.parentToolCallId) continue;
      if (ev.exitCode !== 0) t.errors.push(`CLI result exit code: ${ev.exitCode ?? 'missing'}`);
      else idle = true;
      continue;
    }
    if (!isObject(ev.data)) {
      t.errors.push(`invalid ${ev.type} data at line ${i + 1}`);
      continue;
    }
    const d = ev.data;
    if (ev.type === 'session.error') t.errors.push(`${d.errorType ?? 'error'}: ${d.message ?? 'session failed'}`);
    if (ev.type === 'abort' || (ev.type === 'session.shutdown' && d.shutdownType === 'error')) {
      t.errors.push(d.errorReason ?? 'session aborted');
    }
    // A subagent's answer/idle event cannot finish the root conversation.
    if (ev.agentId || d.parentToolCallId) continue;
    if (ev.type === 'assistant.message') {
      idle = false;
      if (typeof d.content !== 'string') t.errors.push(`missing assistant content at line ${i + 1}`);
      else t.finalText = d.content;
    } else if (ev.type === 'tool.execution_start') {
      idle = false;
      if (typeof d.toolName !== 'string') t.errors.push(`missing tool name at line ${i + 1}`);
      else if (d.toolName.toLowerCase() === 'skill') {
        calls.push({ id: d.toolCallId, name: 'Skill', input: d.arguments ?? {}, confirmed: false });
      } else {
        const aliases = { view: 'Read', glob: 'Glob', rg: 'Grep' };
        calls.push({ name: aliases[d.toolName] ?? d.toolName, input: d.arguments ?? {}, confirmed: true });
      }
    } else if (ev.type === 'tool.execution_complete') {
      const call = typeof d.toolCallId === 'string' && calls.find((c) => c.id === d.toolCallId);
      if (call?.name === 'Skill') call.confirmed = d.success === true;
    } else if (ev.type === 'skill.invoked') {
      idle = false;
      if (typeof d.name !== 'string' || !d.name) t.errors.push(`missing skill name at line ${i + 1}`);
      else {
        const call = calls.findLast((c) => c.name === 'Skill' && c.input.skill === d.name && !c.invoked);
        if (call) { call.confirmed = true; call.invoked = true; call.path = d.path ?? null; }
        else calls.push({ name: 'Skill', input: { skill: d.name }, confirmed: true, path: d.path ?? null });
      }
    } else if (ev.type === 'session.skills_loaded') {
      if (!Array.isArray(d.skills)) t.errors.push(`missing runtime skill listing at line ${i + 1}`);
      else if (t.runtimeSkills !== null) t.errors.push('duplicate runtime skill listing');
      else t.runtimeSkills = d.skills;
    } else if (ev.type === 'session.idle') {
      if (d.aborted) t.errors.push('session cancelled');
      else idle = true;
    } else if (ev.type === 'assistant.turn_start' || ev.type === 'user.message') {
      idle = false;
    }
  }
  for (const call of calls.filter((c) => c.confirmed)) {
    if (call.name === 'Skill') {
      if (typeof call.input.skill !== 'string' || !call.input.skill) {
        t.errors.push('successful skill tool is missing its skill argument');
        continue;
      }
      t.skillInvocations.push({ name: call.input.skill, path: call.path ?? null });
    }
    t.toolCalls.push({ name: call.name, input: call.input });
  }
  t.complete = idle && Boolean(t.finalText.trim()) && t.errors.length === 0;
  return t;
}

export function plannedSessions({ caseCount, runs, ablation }) {
  return caseCount * runs * (ablation === 'with-without' ? 2 : 1);
}

export function buildCopilotArgs({ prompt, model, usageFile, maxAiCredits = 30 }) {
  return [
    '-p', prompt, '--output-format', 'json', '--model', model,
    '--no-ask-user', '--no-custom-instructions', '--disable-builtin-mcps',
    '--no-auto-update', '--trust-folder', '--disallow-temp-dir', '--available-tools=skill,view,glob,rg',
    '--allow-tool=read', '--allow-tool=skill', '--max-ai-credits', String(maxAiCredits),
    '--usage-output-file', usageFile,
  ];
}

function assertCopyableTree(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) throw new Error(`evaluation payload contains a symlink: ${p}`);
    if (s.isDirectory()) assertCopyableTree(p);
    else if (!s.isFile()) throw new Error(`evaluation payload is not a regular file: ${p}`);
  }
}

export function prepareCopilot({ outDir, skillName, skillSourceDir, fixturesDir, cases }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) throw new Error('Copilot skill name must be kebab-case');
  for (const c of cases) {
    const problems = validateCase(c);
    if (c.checks?.some((k) => k.type === 'file_exists')) problems.push('Copilot v1 does not support file_exists checks');
    if (c.fixtures && !fixturesDir) problems.push('case requires a fixtures directory');
    if (problems.length) throw new Error(`${c.id}: ${problems.join('; ')}`);
  }
  const source = realpathSync(skillSourceDir);
  assertCopyableTree(source);
  const skillSnapshot = join(outDir, 'copilot-source', skillName);
  mkdirSync(dirname(skillSnapshot), { recursive: true });
  cpSync(source, skillSnapshot, { recursive: true });
  let fixtureSnapshot = null;
  if (fixturesDir) {
    const fixtures = realpathSync(fixturesDir);
    assertCopyableTree(fixtures);
    fixtureSnapshot = join(outDir, 'copilot-fixtures');
    cpSync(fixtures, fixtureSnapshot, { recursive: true });
  }
  const canaryToken = randomBytes(24).toString('hex');
  writeFileSync(join(outDir, 'canary.txt'), canaryToken);
  return { skillName, skillSnapshot, fixtureSnapshot, skillHash: hashTree(skillSnapshot), canaryToken };
}

// COPILOT_HOME is a configuration boundary, not a credential or OS sandbox.
function homeProblems(home) {
  const problems = [];
  for (const name of [
    'settings.json', 'mcp-config.json', 'lsp-config.json', 'providers.json',
    'extensions', 'hooks', 'installed-plugins', 'agents', 'skills', 'plugin-data',
  ]) {
    const p = join(home, name);
    if (existsSync(p) && (!lstatSync(p).isDirectory() || readdirSync(p).length)) {
      problems.push(`dedicated COPILOT_HOME must not contain customizations: ${name}`);
    }
  }
  return problems;
}

function environmentProblems(env) {
  return Object.keys(env).filter((k) => env[k] && (
    /^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|COPILOT_PROVIDERS_CONFIG|COPILOT_ALLOW_ALL|COPILOT_ASSISTED_APPROVAL)$/i.test(k)
    || /^COPILOT_PROVIDER_/i.test(k)
    || /^(ANTHROPIC|OPENAI|AZURE_OPENAI)_(API_KEY|AUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(k)
  )).map((k) => `${k} is set; subscription-only evaluation requires removing this override`);
}

function skillEntries(listing) {
  if (!Array.isArray(listing)) throw new Error('unsupported Copilot skill-list JSON; expected an array');
  for (const s of listing) {
    if (!isObject(s) || typeof s.name !== 'string' || typeof s.path !== 'string' || typeof s.enabled !== 'boolean') {
      throw new Error('unsupported Copilot skill-list entry; expected name, path, enabled');
    }
  }
  return listing;
}

export function auditSkills(listing, expected) {
  const enabled = skillEntries(listing).filter((s) => s.enabled);
  if (!expected && enabled.length === 0) return;
  if (expected && enabled.length === 1 && enabled[0].name === expected.name) {
    const path = enabled[0].path;
    const dir = path.endsWith('SKILL.md') ? dirname(path) : path;
    if (realpathSync(dir) === realpathSync(expected.path)) return;
  }
  throw new Error(`skill discovery is not clean: expected ${expected?.name ?? 'no enabled skills'}, found ${enabled.map((s) => s.name).join(', ') || 'none'}`);
}

function killTree(child) {
  if (!child.pid) return Promise.resolve(null);
  if (process.platform === 'win32') {
    return new Promise((done) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', (e) => { child.kill(); done(e.message); });
      killer.once('close', (code) => {
        if (code !== 0) child.kill();
        done(code === 0 ? null : `taskkill exited ${code}`);
      });
    });
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {
    if (e.code !== 'ESRCH') return Promise.resolve(e.message);
  }
  return Promise.resolve(null);
}

// Direct file descriptors preserve bytes and avoid buffering model output in memory.
async function execute(exe, args, { cwd, env, stdoutPath, stderrPath, timeoutMs, signal }) {
  const out = openSync(stdoutPath, 'w');
  const err = openSync(stderrPath, 'w');
  let child;
  try {
    child = spawn(exe, args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return new Promise((done) => {
    let error = null;
    let timedOut = false;
    let cancelled = false;
    let stopping = null;
    const stop = () => { stopping ??= killTree(child); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (e) => { error = e.message; });
    child.once('close', async (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const killError = stopping ? await stopping : null;
      done({ exitCode, exitSignal, timedOut, cancelled, error: error ?? killError });
    });
  });
}

export function createCopilotRunner(options = {}) {
  return createAcpRunner({ ...options, client: 'copilot' });
}

export function createLegacyCopilotRunner({ exe, prefixArgs = [], env = process.env, transport = 'sdk' } = {}) {
  if (!['sdk', 'cli'].includes(transport)) throw new Error('unknown Copilot transport');
  exe ??= env.COPILOT_CLI_PATH ?? 'copilot';
  if (transport === 'sdk') {
    if (prefixArgs.length) throw new Error('SDK transport requires a native executable, not prefix arguments');
    if (!isAbsolute(exe)) {
      const suffixes = process.platform === 'win32' && !exe.endsWith('.exe') ? ['.exe'] : [''];
      const candidates = (env.PATH ?? env.Path ?? '').split(delimiter).flatMap((dir) =>
        suffixes.map((suffix) => join(dir, `${exe}${suffix}`)));
      exe = candidates.find((path) => existsSync(path)) ?? exe;
    }
  }
  let clientVersion = null;
  const probe = (args, opts = {}) => spawnSync(exe, [...prefixArgs, ...args], {
    env: { ...env, COPILOT_AUTO_UPDATE: 'false' }, encoding: 'utf8', shell: false,
    windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, ...opts,
  });
  return registerRunner({
    id: 'copilot',
    transport: 'native',
    capabilities: { hermetic: false, skillTrace: true, toolEvidence: true, traceEvidence: true, usageObservable: true, hardLimits: false, implemented: true },
    plannedSessions,
    prepare: prepareCopilot,
    parseTrace: parseCopilotTrace,
    async preflight({ model, maxAiCredits = 30, timeoutSeconds = 120, copilotHome } = {}) {
      const problems = environmentProblems(env);
      if (typeof model !== 'string' || !model.trim() || model.toLowerCase() === 'auto') problems.push('Copilot requires an explicit --model (not auto)');
      if (!Number.isFinite(maxAiCredits) || maxAiCredits < 30) problems.push('--max-ai-credits must be at least 30 (soft, per session)');
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647) problems.push('--timeout-seconds is outside the supported positive timer range');
      if (/\.(cmd|bat)$/i.test(exe)) problems.push('--exe must be a native executable, not a .cmd/.bat wrapper');
      if (transport === 'sdk' && !isAbsolute(exe)) problems.push('SDK requires a resolvable native Copilot path; pass --exe');
      if (copilotHome) problems.push(...homeProblems(resolve(copilotHome)));
      if (problems.length) return { ok: false, version: clientVersion, problems };
      const help = probe(['--help']);
      if (help.error || help.status !== 0) problems.push(`Copilot not runnable: ${help.error?.message ?? help.stderr}`);
      else for (const flag of REQUIRED_FLAGS) {
        if (!help.stdout.includes(flag)) problems.push(`Copilot is missing required public option ${flag}; update CLI or use --exe`);
      }
      if (!problems.length) {
        const version = probe(['--no-auto-update', '--version']);
        if (version.error || version.status !== 0 || !version.stdout.trim()) problems.push(`cannot determine Copilot version: ${version.error?.message ?? version.stderr}`);
        else clientVersion = version.stdout.trim();
      }
      if (transport === 'sdk' && !problems.length) {
        try { await import('@github/copilot-sdk'); } catch (e) {
          problems.push(`Copilot SDK unavailable: ${e.message}; restore engine dependencies`);
        }
      }
      return { ok: problems.length === 0, version: clientVersion, problems, authentication: 'not checked; no model call made' };
    },
    async run(suite, opts) {
      const {
        skillName, skillSnapshot, fixtureSnapshot, canaryToken, outputDir, model,
        runs, ablation, caseId, concurrency = 1, maxAiCredits = 30, timeoutSeconds = 120, copilotHome,
      } = opts;
      const base = {
        client: 'copilot', model, clientVersion, outputDir,
        caveats: [
          `Experimental ${transport.toUpperCase()} adapter; clean live acceptance is required for each CLI build.`,
          'Native subscription authentication; not hermetic. Configuration isolation is not authentication isolation.',
          'AI-credit limit is soft and per session; USD cost is unknown, not zero.',
          'Pre-run and runtime discovery audits are not an OS security boundary.',
        ],
      };
      if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
        || !['none', 'with-without'].includes(ablation)) throw new Error('invalid Copilot scheduling options');
      if (!skillSnapshot || !skillName) throw new Error('Copilot run requires prepare() output');
      const pre = await this.preflight({ model, maxAiCredits, timeoutSeconds, copilotHome });
      if (!pre.ok) return makeRunResult({ ...base, caveats: [...base.caveats, ...pre.problems] });
      base.clientVersion = pre.version;
      const selected = suite.filter((c) => !caseId || c.id === caseId);
      if (!selected.length) throw new Error('no Copilot cases selected');
      for (const c of selected) {
        if (validateCase(c).length || c.checks.some((k) => k.type === 'file_exists')) throw new Error(`unsupported Copilot case: ${c.id}`);
      }
      const root = dirname(outputDir);
      mkdirSync(outputDir, { recursive: true });
      const jobs = selected.flatMap((c) => Array.from({ length: runs }, (_, i) =>
        (ablation === 'with-without' ? ['with', 'without'] : ['with']).map((arm) => ({ c, arm, repeat: i + 1 }))).flat());
      let next = 0;
      let sessions = 0;
      let stopReason = null;
      const receipts = [];
      const controller = new AbortController();
      const cancel = () => { stopReason = 'evaluation interrupted'; controller.abort(); };
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      const worker = async () => {
        while (!stopReason && next < jobs.length) {
          const job = jobs[next++];
          const { c, arm, repeat } = job;
          const traceDir = join(root, 'traces', c.id);
          mkdirSync(traceDir, { recursive: true });
          const tracePath = join(traceDir, `${arm}-${repeat}.jsonl`);
          const receiptPath = `${tracePath}.receipt.json`;
          const stem = join(outputDir, `${c.id}-${arm}-${repeat}`);
          const workspace = mkdtempSync(join(tmpdir(), 'ai-evals-copilot-'));
          const home = copilotHome ? resolve(copilotHome) : mkdtempSync(join(tmpdir(), 'ai-evals-copilot-home-'));
          const childEnv = { ...env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1' };
          let receipt = { caseId: c.id, arm, repeat, started: false, valid: false, error: null };
          try {
            const skillPath = join(workspace, '.github', 'skills', skillName);
            if (arm === 'with') {
              mkdirSync(dirname(skillPath), { recursive: true });
              cpSync(skillSnapshot, skillPath, { recursive: true });
            }
            const fixtures = join(workspace, 'fixtures');
            if (c.fixtures) cpSync(fixtureSnapshot, fixtures, { recursive: true });
            const auditPath = `${stem}.skills.json`;
            const expected = arm === 'with' ? { name: skillName, path: skillPath } : null;
            const prompt = c.fixtures ? c.prompt.replaceAll('{{fixtures}}', fixtures) : c.prompt;
            let proc;
            if (transport === 'sdk') {
              const skillsRoot = dirname(skillPath);
              mkdirSync(skillsRoot, { recursive: true });
              const requestPath = `${stem}.request.json`;
              const startedPath = `${stem}.started`;
              json(requestPath, {
                exe, workspace, home, skillsRoot, expected, prompt, model, maxAiCredits,
                timeoutMs: timeoutSeconds * 1000, auditPath, postAuditPath: `${stem}.skills.post.json`,
                startedPath, usagePath: `${stem}.usage.json`,
              });
              if (controller.signal.aborted || stopReason) throw new Error(stopReason ?? 'evaluation interrupted before prompt launch');
              try {
                proc = await execute(process.execPath, [fileURLToPath(new URL('./copilot-sdk.mjs', import.meta.url)), requestPath], {
                  cwd: workspace, env: childEnv, stdoutPath: tracePath, stderrPath: `${stem}.stderr`,
                  timeoutMs: timeoutSeconds * 1000, signal: controller.signal,
                });
              } finally {
                receipt.started = existsSync(startedPath);
                if (receipt.started) sessions++;
                rmSync(requestPath, { force: true });
              }
              receipt.skillAuditSource = 'sdk-session-rpc';
            } else {
            const runControl = async (args, stdoutPath, stderrPath) => {
              const proc = await execute(exe, [...prefixArgs, '--no-auto-update', ...args], {
                cwd: workspace, env: childEnv, stdoutPath, stderrPath,
                timeoutMs: Math.min(timeoutSeconds * 1000, 15_000), signal: controller.signal,
              });
              if (proc.exitCode !== 0 || proc.error || proc.timedOut || proc.cancelled) {
                throw new Error(`skill-discovery control failed: ${proc.error ?? (read(stderrPath).slice(0, 500) || `exit ${proc.exitCode}`)}`);
              }
            };
            const listSkills = () => runControl(['skill', 'list', '--json'], auditPath, `${stem}.skills.stderr`);
            await listSkills();
            const listing = skillEntries(JSON.parse(read(auditPath)));
            const builtins = listing.filter((s) => s.source === 'builtin' && s.enabled);
            if (!copilotHome && builtins.length) {
              // Use only the public CLI, and mutate only this job's disposable configuration home.
              auditSkills(listing.filter((s) => s.source !== 'builtin'), expected);
              cpSync(auditPath, `${stem}.skills.initial.json`);
              for (const [i, s] of builtins.entries()) {
                await runControl(['skill', 'disable', s.name], `${stem}.skill-disable-${i}.stdout`, `${stem}.skill-disable-${i}.stderr`);
              }
              await listSkills();
            }
            auditSkills(JSON.parse(read(auditPath)), expected);
            if (controller.signal.aborted || stopReason) throw new Error(stopReason ?? 'evaluation interrupted before prompt launch');
            const args = buildCopilotArgs({
              prompt,
              model, maxAiCredits, usageFile: `${stem}.usage.json`,
            });
            receipt.started = true;
            sessions++;
            proc = await execute(exe, [...prefixArgs, ...args], {
              cwd: workspace, env: childEnv, stdoutPath: tracePath, stderrPath: `${stem}.stderr`,
              timeoutMs: timeoutSeconds * 1000, signal: controller.signal,
            });
            }
            const transcript = parseCopilotTrace(read(tracePath));
            receipt = {
              ...receipt, ...proc, complete: transcript.complete,
              valid: proc.exitCode === 0 && !proc.error && !proc.timedOut && !proc.cancelled && transcript.complete,
              error: proc.error ?? (proc.timedOut ? 'session timed out' : proc.cancelled ? 'session cancelled'
                : transport === 'sdk' && proc.exitCode !== 0 ? read(`${stem}.stderr`).trim().slice(0, 1000) || `SDK worker exited ${proc.exitCode}` : null),
              traceErrors: transcript.errors,
            };
            // A listing command and a prompt session can disagree about disabled skills.
            try {
              if (transport === 'sdk') {
                auditSkills(JSON.parse(read(auditPath)).skills, expected);
                auditSkills(JSON.parse(read(`${stem}.skills.post.json`)).skills, expected);
                if (transcript.runtimeSkills !== null) auditSkills(transcript.runtimeSkills, expected);
              } else auditSkills(transcript.runtimeSkills, expected);
            } catch (e) {
              receipt.valid = false;
              receipt.error ??= `runtime skill audit failed: ${e.message}`;
            }
            receipt.canaryTouched = transcript.raw.includes(canaryToken);
            receipt.authFailed = transcript.errors.some((e) => /^authentication:/.test(e))
              || /not (?:logged|signed) in|authentication (?:required|failed)|please (?:log|sign) in/i.test(read(`${stem}.stderr`));
            const unexpectedSkill = transcript.skillInvocations.some((s) => arm !== 'with' || s.name !== skillName);
            if (unexpectedSkill) {
              receipt.valid = false;
              receipt.error = 'unexpected skill invocation; ablation is contaminated';
            }
            if (existsSync(`${stem}.usage.json`)) {
              const usage = JSON.parse(read(`${stem}.usage.json`));
              if (!isObject(usage)) throw new Error('unsupported usage-output-file JSON; expected an object');
              receipt.usage = usage;
            } else if (receipt.valid) {
              receipt.valid = false;
              receipt.error = 'Copilot did not write the requested usage-output-file';
            }
            if (!receipt.valid) {
              receipt.error ??= transcript.errors.join('; ') || read(`${stem}.stderr`).trim().slice(0, 1000) || `invalid trace or exit ${proc.exitCode}`;
              stopReason = receipt.error;
            } else {
              receipt.grade = gradeTranscript(c, transcript, { arm, canaryToken });
              if (receipt.grade.invalid || receipt.grade.score == null) {
                receipt.valid = false;
                receipt.error = receipt.grade.error ?? 'required grading evidence is unavailable';
                stopReason = receipt.error;
              }
            }
          } catch (e) {
            receipt.valid = false;
            receipt.error = e.message;
            stopReason = e.message;
          } finally {
            // Even pre-launch failures get an empty trace and an invalid receipt for offline parity.
            if (!existsSync(tracePath)) writeFileSync(tracePath, '');
            json(receiptPath, receipt);
            receipts.push(receipt);
            rmSync(workspace, { recursive: true, force: true });
            if (!copilotHome) rmSync(home, { recursive: true, force: true });
          }
        }
      };
      try {
        const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, () =>
          worker().catch((e) => { stopReason = e.message; throw e; })));
        const failures = workers.filter((r) => r.status === 'rejected').map((r) => r.reason);
        if (failures.length) throw new AggregateError(failures, 'Copilot evaluation archive or cleanup failed');
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
      const cases = selected.map((c) => {
        const rs = receipts.filter((r) => r.caseId === c.id);
        const scores = (arm) => rs.filter((r) => r.arm === arm && r.valid).map((r) => r.grade.score);
        const withRuns = scores('with');
        const withoutRuns = scores('without');
        const expected = runs * (ablation === 'with-without' ? 2 : 1);
        return {
          id: c.id, withRuns, withoutRuns, withScore: mean(withRuns), withoutScore: mean(withoutRuns),
          delta: mean(withRuns) !== null && mean(withoutRuns) !== null ? mean(withRuns) - mean(withoutRuns) : null,
          verdict: verdict(withRuns, withoutRuns), invalidRuns: rs.filter((r) => !r.valid).length,
          partial: rs.length !== expected || rs.some((r) => !r.valid), partialReason: stopReason, costUsd: null,
        };
      });
      const scores = receipts.filter((r) => r.valid && r.arm === 'with').map((r) => r.grade.score);
      const status = stopReason
        ? receipts.some((r) => r.authFailed) ? CLIENT_STATUS.AUTH_FAILED : sessions ? CLIENT_STATUS.PARTIAL : CLIENT_STATUS.ERROR
        : scores.every((s) => s === 1) ? CLIENT_STATUS.PASSED : CLIENT_STATUS.BELOW_THRESHOLD;
      return makeRunResult({
        ...base, status, sessions, overallScore: mean(scores), cases,
        canaryTouched: receipts.some((r) => r.canaryTouched),
        maxAiCreditsPerSession: maxAiCredits, timeoutSeconds,
        caveats: stopReason ? [...base.caveats, stopReason] : base.caveats,
      });
    },
  });
}
