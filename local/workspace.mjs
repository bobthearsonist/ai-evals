import { createHash, randomBytes } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateCase } from './contract.mjs';

export function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else hash.update(name).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

export function plannedSessions({ caseCount, runs, ablation }) {
  return caseCount * runs * (ablation === 'with-without' ? 2 : 1);
}

function assertCopyableTree(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`evaluation payload contains a symlink: ${path}`);
    if (stat.isDirectory()) assertCopyableTree(path);
    else if (!stat.isFile()) throw new Error(`evaluation payload is not a regular file: ${path}`);
  }
}

export function prepareWorkspace({ outDir, skillName, skillSourceDir, fixturesDir, cases }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) throw new Error('skill name must be kebab-case');
  for (const c of cases) {
    const problems = validateCase(c);
    if (c.checks?.some((check) => check.type === 'file_exists')) problems.push('ACP does not support file_exists checks');
    if (c.fixtures && !fixturesDir) problems.push('case requires a fixtures directory');
    if (problems.length) throw new Error(`${c.id}: ${problems.join('; ')}`);
  }
  const source = realpathSync(skillSourceDir);
  assertCopyableTree(source);
  const skillSnapshot = join(outDir, 'skill-source', skillName);
  mkdirSync(dirname(skillSnapshot), { recursive: true });
  cpSync(source, skillSnapshot, { recursive: true });
  let fixtureSnapshot = null;
  if (fixturesDir) {
    const fixtures = realpathSync(fixturesDir);
    assertCopyableTree(fixtures);
    fixtureSnapshot = join(outDir, 'fixture-source');
    cpSync(fixtures, fixtureSnapshot, { recursive: true });
  }
  const canaryToken = randomBytes(24).toString('hex');
  writeFileSync(join(outDir, 'canary.txt'), canaryToken);
  return { skillName, skillSnapshot, fixtureSnapshot, skillHash: hashTree(skillSnapshot), canaryToken };
}
