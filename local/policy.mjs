import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCase } from './contract.mjs';
import manifest from '../package.json' with { type: 'json' };

const toolchain = {
  engine: manifest.version,
  gherkin: manifest.dependencies['@cucumber/gherkin'],
  expressions: manifest.dependencies['@cucumber/cucumber-expressions'],
  validator: manifest.dependencies.ajv,
};

export function policySnapshot(cases) {
  const definitions = cases.map(({ samples, ...definition }) => definition);
  const sha256 = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
  return { schemaVersion: 1, sha256, toolchain, cases: definitions };
}

export function archivePolicy(outDir, cases, plan) {
  const policy = policySnapshot(cases);
  writeFileSync(join(outDir, 'policy.json'), JSON.stringify(policy, null, 2), { flag: 'wx' });
  writeFileSync(join(outDir, 'plan.json'), JSON.stringify({ ...plan, policySha256: policy.sha256 }, null, 2), { flag: 'wx' });
  return policy;
}

export function replayPolicy(runDir, { currentCases, mode = 'recorded' } = {}) {
  if (!['current', 'recorded'].includes(mode)) throw new Error('--policy must be recorded or current');
  if (mode === 'current') return { ...policySnapshot(currentCases), mode: 'current' };
  const path = join(runDir, 'policy.json');
  if (!existsSync(path)) throw new Error('archived run has no policy snapshot; use --policy current explicitly for legacy runs');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(saved.cases) || saved.schemaVersion !== 1) throw new Error('invalid archived policy');
  for (const c of saved.cases) {
    const problems = validateCase(c);
    if (problems.length) throw new Error(`invalid archived policy ${c.id}: ${problems.join('; ')}`);
  }
  const policy = policySnapshot(saved.cases);
  if (saved.sha256 !== policy.sha256) throw new Error('archived policy hash does not match');
  return { ...policy, toolchain: saved.toolchain ?? null, replayToolchain: toolchain, mode: 'recorded' };
}

export function archiveReplay(runDir, policy, results) {
  const dir = join(runDir, 'regrades');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(), policyMode: policy.mode,
    policySha256: policy.sha256, policy, cases: results,
  }, null, 2), { flag: 'wx' });
  return path;
}
