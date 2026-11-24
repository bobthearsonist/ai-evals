import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

// Depth-first walk from `start`: each reachable dependency once, in discovery
// order, plus the first path that revisits a skill on its own branch (a cycle).
function walkDependencies(dependencies, start) {
  const order = [];
  const seen = new Set();
  const visit = (skill, path) => {
    for (const dependency of Object.hasOwn(dependencies, skill) ? dependencies[skill] : []) {
      if (path.includes(dependency)) return [...path, dependency];
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      order.push(dependency);
      const cycle = visit(dependency, [...path, dependency]);
      if (cycle) return cycle;
    }
    return null;
  };
  const cycle = visit(start, [start]);
  return { order, cycle };
}

export function validateSkillDependencies(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('skillDependencies must be an object mapping skill names to arrays of skill names');
  const dependencies = {};
  for (const [skill, names] of Object.entries(value)) {
    if (!SKILL_NAME.test(skill)) throw new Error(`skillDependencies: "${skill}" is not a kebab-case skill name`);
    if (!Array.isArray(names)) throw new Error(`skillDependencies.${skill} must be an array of skill names`);
    for (const name of names) {
      if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw new Error(`skillDependencies.${skill}: ${JSON.stringify(name)} is not a kebab-case skill name`);
      if (name === skill) throw new Error(`skillDependencies.${skill} must not depend on itself`);
    }
    if (new Set(names).size !== names.length) throw new Error(`skillDependencies.${skill} lists a dependency more than once`);
    dependencies[skill] = [...names];
  }
  for (const skill of Object.keys(dependencies)) {
    const { cycle } = walkDependencies(dependencies, skill);
    if (cycle) throw new Error(`skillDependencies contains a cycle: ${cycle.join(' -> ')}`);
  }
  return dependencies;
}

// Direct and transitive dependencies of `skill`, excluding the skill itself.
export function skillDependencyClosure(dependencies, skill) {
  const { order, cycle } = walkDependencies(dependencies ?? {}, skill);
  if (cycle) throw new Error(`skillDependencies contains a cycle: ${cycle.join(' -> ')}`);
  return order;
}

function discoverConfig(cwd) {
  let directory = resolve(cwd);
  while (true) {
    for (const candidate of [resolve(directory, 'evals', 'evals.json'), resolve(directory, 'evals.json')]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// Config paths are relative to the config file; defaults still belong to the caller.
export function resolveConfig({ configPath, flags = {}, cwd = process.cwd() } = {}) {
  const selectedConfig = configPath ? resolve(cwd, configPath) : discoverConfig(cwd);
  let cfg = {};
  let base = resolve(cwd, 'evals');
  if (selectedConfig) {
    if (!existsSync(selectedConfig)) throw new Error(`config not found: ${selectedConfig}`);
    cfg = JSON.parse(readFileSync(selectedConfig, 'utf8'));
    base = dirname(selectedConfig);
  }
  const abs = (v, from = base) => (isAbsolute(v) ? v : resolve(from, v));
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(';')).filter(Boolean);
  const rootOverride = flags.skillRoot ?? process.env.EVAL_SKILL_ROOT;
  const skillsRoots = list(rootOverride ?? cfg.skillsRoots).map((r) => abs(r, rootOverride ? cwd : base));
  return {
    casesDir: abs(flags.casesDir ?? cfg.casesDir ?? 'cases', flags.casesDir ? cwd : base),
    skillsRoots: skillsRoots.length ? skillsRoots : [resolve(base, '..', 'skills')],
    outputDir: abs(flags.outputDir ?? cfg.outputDir ?? '.work/local-runs', flags.outputDir ? cwd : base),
    resultsDir: abs(flags.resultsDir ?? cfg.resultsDir ?? '.work/results', flags.resultsDir ? cwd : base),
    instructionFile: flags.instructionFile ? abs(flags.instructionFile, cwd) : cfg.instructionFile ? abs(cfg.instructionFile) : null,
    suites: cfg.suites ?? {},
    skillDependencies: validateSkillDependencies(cfg.skillDependencies),
  };
}

// A suite id may map to a differently named skill and cases folder; default is identity.
export function suiteSettings(config, suite) {
  const s = config.suites[suite] ?? {};
  return { skill: s.skill ?? suite, casesFolder: s.cases ?? suite };
}
