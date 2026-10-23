import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

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
    suites: cfg.suites ?? {},
  };
}

// A suite id may map to a differently named skill and cases folder; default is identity.
export function suiteSettings(config, suite) {
  const s = config.suites[suite] ?? {};
  return { skill: s.skill ?? suite, casesFolder: s.cases ?? suite };
}
