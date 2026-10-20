import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);

export function slim(normalized, suite) {
  return {
    suite,
    at: new Date().toISOString(),
    status: normalized.status,
    skillSha256: normalized.skillSha256 ?? null,
    runs: normalized.runs ?? null,
    costUsd: normalized.costUsd ?? null,
    cases: (normalized.cases ?? []).map((c) => ({
      id: c.id, withScore: r2(c.withScore), withoutScore: r2(c.withoutScore), delta: r2(c.delta),
      verdict: c.verdict, withRuns: c.withRuns, withoutRuns: c.withoutRuns, invalidRuns: c.invalidRuns,
    })),
  };
}

export function diffRuns(prev, cur) {
  if (!prev) return [];
  const before = new Map(prev.cases.map((c) => [c.id, c]));
  return cur.cases.map((c) => {
    const p = before.get(c.id);
    return {
      id: c.id,
      isNew: !p,
      withChange: p && c.withScore != null && p.withScore != null ? r2(c.withScore - p.withScore) : null,
      deltaChange: p && c.delta != null && p.delta != null ? r2(c.delta - p.delta) : null,
      verdictChange: p && p.verdict !== c.verdict ? `${p.verdict} -> ${c.verdict}` : null,
    };
  });
}

// Writes <resultsDir>/<suite>/<timestamp>.json and latest.json; returns the diff against the previous latest.
export function recordRun(resultsDir, suite, normalized) {
  const dir = join(resultsDir, suite);
  mkdirSync(dir, { recursive: true });
  const latestPath = join(dir, 'latest.json');
  const prev = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, 'utf8')) : null;
  const cur = slim(normalized, suite);
  const body = JSON.stringify(cur, null, 2);
  writeFileSync(join(dir, `${cur.at.replace(/[:.]/g, '-')}.json`), body);
  writeFileSync(latestPath, body);
  return { current: cur, previous: prev, diff: diffRuns(prev, cur) };
}

export function renderMarkdown(suites) {
  const lines = ['# Eval summary', '', '| Suite | Case | With | Without | Delta | Verdict | Invalid |', '|---|---|---|---|---|---|---|'];
  for (const s of suites) {
    for (const c of s.cases) lines.push(`| ${s.suite} | ${c.id} | ${c.withScore ?? '-'} | ${c.withoutScore ?? '-'} | ${c.delta ?? '-'} | ${c.verdict} | ${c.invalidRuns} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function loadLatest(resultsDir, suite) {
  const p = join(resultsDir, suite, 'latest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
