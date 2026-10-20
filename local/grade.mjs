// Client-neutral transcript model and pure grader. Drivers turn a client's raw trace into a
// transcript; grading is then a deterministic function of (case, transcript, arm), so archived
// traces can be re-graded offline at no cost.

// transcript: { finalText, toolCalls: [{ name, input }], raw }
export function parseClaudeTrace(text) {
  const t = { finalText: '', toolCalls: [], raw: text, complete: false };
  let lastAssistantText = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant') {
      const parts = ev.message?.content ?? [];
      const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (txt) lastAssistantText = txt;
      for (const p of parts) if (p.type === 'tool_use') t.toolCalls.push({ name: p.name, input: p.input ?? {} });
    } else if (ev.type === 'result') {
      t.complete = true;
      if (typeof ev.result === 'string') t.finalText = ev.result;
    }
  }
  if (!t.finalText) t.finalText = lastAssistantText;
  return t;
}

function gradeCheck(k, transcript) {
  const name = k.name ?? k.pattern ?? k.type;
  if (k.type === 'regex' || k.type === 'not_regex') {
    const hay = (k.target ?? 'last_message') === 'trace' ? transcript.raw : transcript.finalText;
    const hit = new RegExp(k.pattern, k.flags ?? '').test(hay);
    return { name, passed: k.type === 'regex' ? hit : !hit };
  }
  if (k.type === 'tool_order') {
    const idx = (n) => transcript.toolCalls.findIndex((c) => c.name === n);
    const b = idx(k.before);
    const a = idx(k.after);
    return { name, passed: b !== -1 && a !== -1 && b < a };
  }
  // file_exists needs a workdir snapshot, which transcripts don't carry.
  return { name, passed: null, skipped: true };
}

// Returns { score, checks } with score = fraction of gradable checks passed.
// Adds the skill-trigger check (with-arm must call Skill when the case expects it; the
// without-arm must never) and the canary check.
export function gradeTranscript(c, transcript, { arm, canaryToken } = {}) {
  const checks = c.checks.map((k) => gradeCheck(k, transcript));
  const skillCalls = transcript.toolCalls.filter((t) => t.name === 'Skill').length;
  if (c.shouldTrigger) {
    if (arm === 'with') checks.push({ name: 'skill-trigger', passed: skillCalls >= 1 });
  } else {
    checks.push({ name: 'skill-trigger', passed: skillCalls === 0 });
  }
  if (canaryToken) checks.push({ name: 'canary', passed: !transcript.raw.includes(canaryToken) });
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


