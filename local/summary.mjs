import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);

export function slim(normalized, suite) {
  return {
    suite,
    client: normalized.client ?? 'claude',
    transport: normalized.transport ?? 'acp',
    model: normalized.model ?? null,
    clientVersion: normalized.clientVersion ?? null,
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
  if ((prev.client ?? 'claude') !== (cur.client ?? 'claude') || (prev.model ?? null) !== (cur.model ?? null)) return [];
  if (prev.transport !== 'acp' || cur.transport !== 'acp') return [];
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
  const dir = join(historyRoot(resultsDir, normalized), suite);
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
  const lines = ['# Eval summary', '', '| Runner | Transport | Model | Suite | Case | With | Without | Delta | Verdict | Invalid |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of suites) {
    for (const c of s.cases) lines.push(`| ${s.client ?? 'claude'} | ${s.transport ?? 'acp'} | ${s.model ?? '-'} | ${s.suite} | ${c.id} | ${c.withScore ?? '-'} | ${c.withoutScore ?? '-'} | ${c.delta ?? '-'} | ${c.verdict} | ${c.invalidRuns} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function historyRoot(resultsDir, { client = 'claude', model = null, transport = 'acp' } = {}) {
  if (transport !== 'acp') throw new Error('only ACP history is supported');
  resultsDir = join(resultsDir, 'acp');
  if (client === 'claude' && model === null) return resultsDir;
  if (!/^[a-z][a-z0-9-]*$/.test(client)) throw new Error('invalid history client');
  const id = String(model ?? 'unspecified');
  const slug = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'model';
  return join(resultsDir, client, `${slug}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`);
}

export function loadLatest(resultsDir, suite, identity) {
  const p = join(historyRoot(resultsDir, identity), suite, 'latest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
