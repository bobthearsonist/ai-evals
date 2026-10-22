import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gradeTranscript, verdict } from './grade.mjs';

// Re-grades archived traces (<runDir>/traces/<case>/<arm>-<n>.jsonl) with the shared grader.
// `parse` is the client's trace parser. Runs without a final result are excluded, as in live runs.
export function regradeRun({ tracesDir, cases, parse, canaryToken, requireReceipt = false }) {
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return cases.map((c) => {
    const dir = join(tracesDir, c.id);
    const scores = { with: [], without: [] };
    let invalidRuns = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).sort()) {
        const match = /^(with|without)-\d+\.jsonl$/.exec(f);
        if (!match) continue;
        const arm = match[1];
        const receiptPath = join(dir, `${f}.receipt.json`);
        if (requireReceipt || existsSync(receiptPath)) {
          if (!existsSync(receiptPath)) { invalidRuns++; continue; }
          const r = JSON.parse(readFileSync(receiptPath, 'utf8'));
          if (r.valid !== true || r.exitCode !== 0 || r.timedOut || r.cancelled || r.error) { invalidRuns++; continue; }
        }
        const t = parse(readFileSync(join(dir, f), 'utf8'));
        if (!t.complete) { invalidRuns++; continue; }
        const g = gradeTranscript(c, t, { arm, canaryToken });
        if (g.invalid || g.score == null) invalidRuns++;
        else scores[arm].push(g.score);
      }
    }
    return {
      id: c.id, withScore: mean(scores.with), withoutScore: mean(scores.without),
      delta: mean(scores.with) != null && mean(scores.without) != null ? mean(scores.with) - mean(scores.without) : null,
      verdict: verdict(scores.with, scores.without), withRuns: scores.with, withoutRuns: scores.without, invalidRuns,
    };
  });
}
