import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compileFeature } from './suite.mjs';

const kebab = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'case';

function uniqueName(value, used, warnings, description) {
  const base = kebab(value);
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}-${suffix++}`;
  used.add(name);
  if (name !== value) warnings.push(`${description} "${value}" was renamed to "${name}".`);
  return name;
}

function quoted(value, context) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new Error(`${context} must be a single-line string`);
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function docString(value, context) {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  const delimiter = value.includes('"""') ? (value.includes('```') ? null : '```') : '"""';
  if (!delimiter) throw new Error(`${context} contains both supported Doc String delimiters`);
  return `      ${delimiter}\n${value.split(/\r?\n/).map((line) => `      ${line}`).join('\n')}\n      ${delimiter}`;
}

function checkStep(check, name, sourceVersion) {
  const named = (step) => `${step} named ${quoted(name, `check ${name} name`)}`;
  switch (check.type) {
    case 'regex':
    case 'not_regex': {
      const target = sourceVersion === 1
        ? (check.target === 'trace' ? 'trace' : 'response')
        : ({ trace: 'trace', commit_subject: 'commit subject' }[check.target] ?? 'response');
      const verb = check.type === 'regex' ? 'matches' : 'does not match';
      const flags = quoted(check.flags ?? '', `check ${name} flags`);
      const header = `the ${target} ${verb} regex named ${quoted(name, `check ${name} name`)} with flags ${flags}:`;
      return `${header}\n${docString(check.pattern, `check ${name} pattern`)}`;
    }
    case 'contains':
    case 'not_contains':
    case 'starts_with': {
      const target = check.target === 'commit_subject' ? 'commit subject' : 'response';
      const verb = { contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with' }[check.type];
      return named(`the ${target} ${verb} ${quoted(check.value, `check ${name} value`)}`);
    }
    case 'max_length':
    case 'length_less_than': {
      const target = check.target === 'commit_subject' ? 'commit subject' : 'response';
      const verb = check.type === 'max_length' ? 'is at most' : 'is shorter than';
      if (!Number.isInteger(check.limit)) throw new Error(`check ${name} limit must be an integer`);
      return named(`the ${target} ${verb} ${check.limit} characters`);
    }
    case 'conventional_header':
      return named(`the commit subject uses a conventional header with types ${quoted(check.types.join(','), `check ${name} types`)}`);
    case 'lowercase_initial':
      return named('the commit subject description starts with a lowercase letter');
    case 'file_exists':
      return named(`the file snapshot contains ${quoted(check.path, `check ${name} path`)}`);
    case 'tool_order':
      return named(`the response calls tools in order ${quoted(check.before, `check ${name} before tool`)} then ${quoted(check.after, `check ${name} after tool`)}`);
    default:
      throw new Error(`check ${name} uses unsupported type "${check.type}"`);
  }
}

/**
 * Convert a directory of legacy JSON cases into Gherkin and sample sidecars.
 * This is synchronous and read-only: it reads JSON files and returns generated content without writing files.
 * @param {string} srcDir Directory containing one JSON file per case.
 * @param {{featureName?: string}} [options]
 * @returns {{feature: string, samples: Array<{fileName: string, content: object}>, warnings: string[]}}
 */
export function migrateJsonCases(srcDir, options = {}) {
  if (typeof srcDir !== 'string' || !srcDir) throw new TypeError('srcDir must be a non-empty directory path');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const featureName = options.featureName ?? 'Migrated JSON cases';
  if (typeof featureName !== 'string' || !featureName.trim() || /[\r\n]/.test(featureName)) {
    throw new TypeError('options.featureName must be a non-empty single-line string');
  }

  const warnings = [];
  const usedCaseIds = new Set();
  const samples = [];
  const lines = [`Feature: ${featureName.trim()}`, ''];
  const files = readdirSync(srcDir).filter((file) => file.endsWith('.json') && !file.endsWith('.samples.json')).sort();
  if (!files.length) throw new Error(`${srcDir}: no JSON case files found`);

  for (const file of files) {
    const path = join(srcDir, file);
    let legacy;
    try {
      legacy = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`${path}: invalid JSON: ${error.message}`, { cause: error });
    }
    const context = `${path}: case ${legacy?.id ?? basename(file, '.json')}`;
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error(`${context}: case must be an object`);
    if (legacy.schemaVersion !== undefined && ![1, 2].includes(legacy.schemaVersion)) {
      throw new Error(`${context}: unsupported schemaVersion ${legacy.schemaVersion}; expected 1 or 2`);
    }
    if (legacy.fixtures === true) {
      throw new Error(`${context}: fixture cases require copying their fixture directory separately; the migration result only contains feature and sample files`);
    }
    if (!Array.isArray(legacy.checks) || !legacy.checks.length) throw new Error(`${context}: checks must be a non-empty array`);
    const id = uniqueName(legacy.id ?? basename(file, '.json'), usedCaseIds, warnings, `case ID in ${file}`);
    const usedChecks = new Set();
    const checks = legacy.checks.map((check, index) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error(`${context}: check ${index + 1} must be an object`);
      const originalName = check.name ?? `${check.type ?? 'check'}-${index + 1}`;
      const name = uniqueName(originalName, usedChecks, warnings, `check name in ${file}`);
      try {
        return checkStep(check, name, legacy.schemaVersion ?? 1);
      } catch (error) {
        throw new Error(`${context}, check "${originalName}": ${error.message}`, { cause: error });
      }
    });
    if (typeof legacy.prompt !== 'string' || !legacy.prompt.trim()) throw new Error(`${context}: prompt must be a non-empty string`);
    if (typeof legacy.shouldTrigger !== 'boolean') throw new Error(`${context}: shouldTrigger must be boolean`);
    const sample = legacy.samples;
    if (!sample || !['pass', 'fail'].every((key) => Array.isArray(sample[key]) && sample[key].length > 0
      && sample[key].every((text) => typeof text === 'string' && text.length > 0))) {
      throw new Error(`${context}: samples must include non-empty pass and fail string arrays`);
    }

    lines.push(`  @case:${id} @${legacy.shouldTrigger ? 'should-trigger' : 'should-not-trigger'}`);
    lines.push(`  Scenario: ${id.replaceAll('-', ' ')}`);
    lines.push('    When the user asks:');
    lines.push(docString(legacy.prompt, `${context} prompt`));
    checks.forEach((step, index) => {
      lines.push(`    ${index ? 'And' : 'Then'} ${step}`);
    });
    lines.push('');
    samples.push({
      fileName: `${id}.samples.json`,
      content: { caseId: id, pass: sample.pass, fail: sample.fail },
    });
  }

  const feature = `${lines.join('\n').trimEnd()}\n`;
  try {
    const compiled = compileFeature(feature, { uri: 'migrated.feature' });
    for (const c of compiled) {
      if (c.checks.some((check) => !/^[a-z0-9][a-z0-9-]*$/.test(check.name))) {
        throw new Error(`case ${c.id} contains a non-kebab-case check name`);
      }
    }
  } catch (error) {
    throw new Error(`generated feature is invalid: ${error.message}`, { cause: error });
  }
  return { feature, samples, warnings };
}
