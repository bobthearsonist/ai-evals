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
    // Instruction suites treat --instruction-file as a candidate override, but
    // reject a config-level instructionFile as ambiguous environment.
    instructionFileFromFlag: Boolean(flags.instructionFile),
    baselineInstructionFile: flags.baselineInstructionFile ? abs(flags.baselineInstructionFile, cwd) : null,
    suites: validateSuites(cfg.suites, abs),
    skillDependencies: validateSkillDependencies(cfg.skillDependencies),
  };
}

const SUITE_SUBJECTS = ['skill', 'instructions'];

// A suite ablates either a skill (default) or a project instruction file. In an
// instructions suite the with arm stages `instructions` and the without arm
// stages `baselineInstructions`, or no instruction file when that is null.
function validateSuites(value, abs) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('suites must be an object');
  const suites = {};
  for (const [id, s] of Object.entries(value)) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error(`suites.${id} must be an object`);
    const subject = s.subject ?? 'skill';
    if (!SUITE_SUBJECTS.includes(subject)) throw new Error(`suites.${id}.subject must be one of: ${SUITE_SUBJECTS.join(', ')}`);
    if (subject === 'instructions') {
      if (s.skill !== undefined) throw new Error(`suites.${id}: an instructions suite does not name a skill`);
      if (typeof s.instructions !== 'string' || !s.instructions) throw new Error(`suites.${id}: an instructions suite requires an "instructions" path`);
      if (s.baselineInstructions !== undefined && s.baselineInstructions !== null && typeof s.baselineInstructions !== 'string') {
        throw new Error(`suites.${id}.baselineInstructions must be a path or null`);
      }
      suites[id] = {
        ...s, subject,
        instructions: abs(s.instructions),
        baselineInstructions: s.baselineInstructions ? abs(s.baselineInstructions) : null,
      };
    } else {
      if (s.instructions !== undefined || s.baselineInstructions !== undefined) {
        throw new Error(`suites.${id}: instructions paths require "subject": "instructions"`);
      }
      suites[id] = { ...s, subject };
    }
  }
  return suites;
}

// A suite id may map to a differently named skill and cases folder; default is identity.
export function suiteSettings(config, suite) {
  const s = config.suites[suite] ?? {};
  if (s.subject === 'instructions') {
    return {
      subject: 'instructions', skill: null, casesFolder: s.cases ?? suite,
      instructions: s.instructions, baselineInstructions: s.baselineInstructions,
    };
  }
  return { subject: 'skill', skill: s.skill ?? suite, casesFolder: s.cases ?? suite };
}

// Resolves the instruction files for one suite. Skill suites stage the shared
// environment file in both arms; instructions suites ablate candidate vs baseline.
export function suiteInstructions(config, settings) {
  if (settings.subject !== 'instructions') {
    if (config.baselineInstructionFile) throw new Error('--baseline-instruction-file is only supported by instructions suites');
    return { candidate: config.instructionFile, baseline: config.instructionFile };
  }
  if (config.instructionFile && !config.instructionFileFromFlag) {
    throw new Error('config instructionFile is ambiguous for an instructions suite; set the suite\'s "instructions" instead');
  }
  return {
    candidate: config.instructionFileFromFlag ? config.instructionFile : settings.instructions,
    baseline: config.baselineInstructionFile ?? settings.baselineInstructions,
  };
}
