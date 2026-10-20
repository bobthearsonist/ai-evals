import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateCase } from './contract.mjs';

export function loadSuite(suiteDir) {
  const cases = readdirSync(suiteDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(suiteDir, f), 'utf8')));
  for (const c of cases) {
    const problems = validateCase(c);
    if (problems.length) throw new Error(`invalid case ${c?.id}: ${problems.join('; ')}`);
  }
  return cases;
}

function hashTree(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(name).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const q = (s) => JSON.stringify(s);

function graderMd({ type, weight = 1, arm = 'both', extra = {}, body = '' }) {
  const lines = ['---', `type: ${type}`, `weight: ${weight}`, `arm: ${arm}`];
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${typeof v === 'string' ? q(v) : v}`);
  lines.push('---', body);
  return lines.join('\n') + '\n';
}

/**
 * Compiles neutral cases into a throwaway Claude plugin directory.
 * The skill is copied byte-for-byte from the source; its tree hash is returned.
 */
export function compileClaudePlugin({ outDir, skillName, skillSourceDir, cases, fixturesDir = null, canaryToken = randomBytes(12).toString('hex'), maxTurns = 6, timeoutSeconds = 120 }) {
  const pluginRoot = join(outDir, 'plugin');
  mkdirSync(outDir, { recursive: true });
  // Planted outside the plugin so it only appears in a trace if a run reads outside its plugin.
  writeFileSync(join(outDir, 'canary.txt'), canaryToken);
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: `eval-${skillName}`, version: '0.0.0', description: `Local eval wrapper for ${skillName}` }, null, 2),
  );
  cpSync(skillSourceDir, join(pluginRoot, 'skills', skillName), { recursive: true });
  const skillHash = hashTree(join(pluginRoot, 'skills', skillName));

  for (const c of cases) {
    const dir = join(pluginRoot, 'evals', c.id);
    mkdirSync(join(dir, 'graders'), { recursive: true });
    writeFileSync(
      join(dir, 'prompt.md'),
      `---\nmax_turns: ${maxTurns}\ntimeout_seconds: ${timeoutSeconds}\nallowed_tools: [${c.fixtures ? 'Skill, Read, Glob, Grep' : 'Skill'}]\nruns: 3\n---\n${c.fixtures ? c.prompt.replaceAll('{{fixtures}}', join(dir, 'resources')) : c.prompt}\n`,
    );
    if (c.fixtures) {
      if (!fixturesDir) throw new Error(`case ${c.id} needs fixtures but suite has no fixtures directory`);
      // Read-only fixture directory exposed through add_dirs; no scaffold script or Bash needed.
      cpSync(fixturesDir, join(dir, 'resources'), { recursive: true });
      writeFileSync(join(dir, 'case.yaml'), `schema_version: "1.1"\nname: ${c.id}\ncontext:\n  add_dirs: [resources]\n`);
    }
    c.checks.forEach((k, i) => {
      let type = 'regex';
      let extra;
      if (k.type === 'file_exists') {
        type = 'file_exists';
        extra = { path: k.path, exists: k.exists !== false };
      } else if (k.type === 'tool_order') {
        type = 'tool_order';
        extra = { before: k.before, after: k.after };
      } else {
        extra = { pattern: k.pattern, target: k.target ?? 'last_message' };
        if (k.flags) extra.flags = k.flags;
        if (k.type === 'not_regex') extra.match = 'not_contains';
      }
      writeFileSync(join(dir, 'graders', `${String(i + 1).padStart(2, '0')}-${k.name ?? 'check'}.md`), graderMd({ type, extra }));
    });
    writeFileSync(
      join(dir, 'graders', '90-skill-trigger.md'),
      graderMd({
        type: 'tool_used',
        arm: c.shouldTrigger ? 'with-only' : 'both',
        extra: c.shouldTrigger ? { tool: 'Skill', min: 1 } : { tool: 'Skill', min: 0, max: 0 },
      }),
    );
    writeFileSync(
      join(dir, 'graders', '99-canary.md'),
      graderMd({ type: 'regex', extra: { pattern: canaryToken, target: 'trace', match: 'not_contains' } }),
    );
  }
  return { pluginRoot, skillHash, canaryToken };
}
