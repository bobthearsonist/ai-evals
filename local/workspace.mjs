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

// `dependencies` are skills the skill under test loads; they are snapshotted
// beside it so the run records exactly which dependency content it used.
function snapshotInstruction(file, target) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('instruction file must be a regular file, not a symlink');
  const content = readFileSync(file);
  writeFileSync(target, content, { flag: 'wx' });
  return { snapshot: target, sha256: createHash('sha256').update(content).digest('hex') };
}

// `ablationSubject` 'instructions' runs without a skill: the with arm stages
// `instructionFile` and the without arm `baselineInstructionFile` (or none).
export function prepareWorkspace({
  outDir, skillName = null, skillSourceDir = null, fixturesDir, instructionFile, baselineInstructionFile = null,
  cases, dependencies = [], ablationSubject = 'skill',
}) {
  if (!['skill', 'instructions'].includes(ablationSubject)) throw new Error('ablation subject must be skill or instructions');
  if (ablationSubject === 'instructions') {
    if (skillName || skillSourceDir || dependencies.length) throw new Error('an instructions ablation stages no skill or skill dependencies');
    if (!instructionFile) throw new Error('an instructions ablation requires a candidate instruction file');
  } else {
    if (baselineInstructionFile) throw new Error('a baseline instruction file requires an instructions ablation');
    if (typeof skillName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(skillName)) throw new Error('skill name must be kebab-case');
  }
  if (!Array.isArray(dependencies)) throw new Error('skill dependencies must be an array');
  const dependencyNames = dependencies.map((dependency) => dependency?.name);
  for (const name of dependencyNames) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('skill dependency name must be kebab-case');
    if (name === skillName) throw new Error(`skill "${skillName}" cannot be its own dependency`);
  }
  if (new Set(dependencyNames).size !== dependencyNames.length) throw new Error('skill dependencies must be distinct');
  for (const c of cases) {
    const problems = validateCase(c);
    if (c.checks?.some((check) => check.type === 'file_exists')) problems.push('ACP does not support file_exists checks');
    if (c.fixtures && !fixturesDir) problems.push('case requires a fixtures directory');
    if (problems.length) throw new Error(`${c.id}: ${problems.join('; ')}`);
  }
  const source = skillSourceDir ? realpathSync(skillSourceDir) : null;
  if (source) assertCopyableTree(source);
  const dependencySources = dependencies.map(({ name, sourceDir }) => {
    const dependencySource = realpathSync(sourceDir);
    assertCopyableTree(dependencySource);
    return { name, source: dependencySource };
  });
  const skillSnapshot = source ? join(outDir, 'skill-source', skillName) : null;
  if (source) {
    mkdirSync(dirname(skillSnapshot), { recursive: true });
    cpSync(source, skillSnapshot, { recursive: true });
  }
  const dependencySnapshots = dependencySources.map(({ name, source: dependencySource }) => {
    const snapshot = join(outDir, 'skill-source', name);
    cpSync(dependencySource, snapshot, { recursive: true });
    return { name, snapshot, sha256: hashTree(snapshot) };
  });
  let fixtureSnapshot = null;
  if (fixturesDir) {
    const fixtures = realpathSync(fixturesDir);
    assertCopyableTree(fixtures);
    fixtureSnapshot = join(outDir, 'fixture-source');
    cpSync(fixtures, fixtureSnapshot, { recursive: true });
  }
  const candidate = instructionFile ? snapshotInstruction(instructionFile, join(outDir, 'instruction-source.md')) : null;
  const baseline = baselineInstructionFile ? snapshotInstruction(baselineInstructionFile, join(outDir, 'instruction-baseline.md')) : null;
  const canaryToken = randomBytes(24).toString('hex');
  writeFileSync(join(outDir, 'canary.txt'), canaryToken);
  return {
    ablationSubject, skillName, skillSnapshot, fixtureSnapshot, skillHash: skillSnapshot ? hashTree(skillSnapshot) : null,
    dependencies: dependencySnapshots,
    instructionSnapshot: candidate?.snapshot ?? null, instructionHash: candidate?.sha256 ?? null,
    baselineInstructionSnapshot: baseline?.snapshot ?? null, baselineInstructionHash: baseline?.sha256 ?? null,
    canaryToken,
  };
}
