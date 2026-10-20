import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gradeTranscript, verdict } from './grade.mjs';

// Re-grades archived traces (<runDir>/traces/<case>/<arm>-<n>.jsonl) with the shared grader.
// `parse` is the client's trace parser. Runs without a final result are excluded, as in live runs.
export function regradeRun({ tracesDir, cases, parse, canaryToken }) {
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return cases.map((c) => {
    const dir = join(tracesDir, c.id);
    const scores = { with: [], without: [] };
    let invalidRuns = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).sort()) {
        const arm = f.startsWith('with-') ? 'with' : f.startsWith('without-') ? 'without' : null;
        if (!arm) continue;
        const t = parse(readFileSync(join(dir, f), 'utf8'));
        if (!t.complete) { invalidRuns++; continue; }
        const g = gradeTranscript(c, t, { arm, canaryToken });
        if (g.score != null) scores[arm].push(g.score);
      }
    }
    return {
      id: c.id, withScore: mean(scores.with), withoutScore: mean(scores.without),
      delta: mean(scores.with) != null && mean(scores.without) != null ? mean(scores.with) - mean(scores.without) : null,
      verdict: verdict(scores.with, scores.without), withRuns: scores.with, withoutRuns: scores.without, invalidRuns,
    };
  });
}
