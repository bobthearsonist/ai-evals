import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

// Defaults belong to the calling repo, never the installed engine's directory.
// Config paths are relative to the config file so a repo's evals/ folder is self-contained.
export function resolveConfig({ configPath, flags = {}, cwd = process.cwd() } = {}) {
  let cfg = {};
  let base = resolve(cwd, 'evals');
  if (configPath) {
    const p = resolve(cwd, configPath);
    if (!existsSync(p)) throw new Error(`config not found: ${p}`);
    cfg = JSON.parse(readFileSync(p, 'utf8'));
    base = dirname(p);
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
