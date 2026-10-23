import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';
import { validateCase } from './contract.mjs';
import { compileStep, nameCheck } from './expressions.mjs';

const at = (uri, location = {}) => `${uri}:${location.line ?? 1}:${location.column ?? 1}`;
const fail = (uri, location, message) => { throw new Error(`${at(uri, location)}: ${message}`); };
const validId = (id) => /^[a-z0-9][a-z0-9-]*$/.test(id ?? '');

function validate(c, uri, location) {
  const problems = validateCase(c);
  if (problems.length) fail(uri, location, `invalid case ${c?.id}: ${problems.join('; ')}`);
}

export function compileFeature(source, { uri = '<feature>' } = {}) {
  if (typeof source !== 'string') throw new TypeError('feature source must be a string');
  const envelopes = [...generateMessages(source, uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.incrementing(),
  })];
  const errors = envelopes.flatMap((envelope) => envelope.parseError ? [envelope.parseError] : []);
  if (errors.length) fail(uri, errors[0].source?.location, errors.map((error) => error.message).join('; '));
  const feature = envelopes.find((envelope) => envelope.gherkinDocument)?.gherkinDocument.feature;
  if (!feature) fail(uri, undefined, 'Feature required');
  if (feature.language !== 'en') fail(uri, feature.location, 'only English Gherkin is supported');

  const nodes = new Map();
  const rows = new Map();
  const scenarios = new Map();
  const checkTags = (tags) => {
    for (const tag of tags) {
      if (!/^@(?:case:.+|suite:[a-z0-9][a-z0-9-]*|should-trigger|should-not-trigger)$/.test(tag.name)) {
        fail(uri, tag.location, `unsupported tag ${tag.name}`);
      }
    }
  };
  checkTags(feature.tags);
  for (const child of feature.children) {
    if (child.rule) fail(uri, child.rule.location, 'Rule is unsupported');
    const node = child.background ?? child.scenario;
    if (!node) fail(uri, feature.location, 'unsupported feature child');
    nodes.set(node.id, node);
    if (!child.background) {
      checkTags(node.tags);
      scenarios.set(node.id, node);
    }
    let phase;
    for (const step of node.steps) {
      nodes.set(step.id, step);
      const keyword = step.keyword.trim();
      if (!['Given', 'When', 'Then', 'And', 'But'].includes(keyword)) fail(uri, step.location, `unsupported keyword ${keyword}`);
      if (['Given', 'When', 'Then'].includes(keyword)) phase = step.keywordType;
      if (!phase) fail(uri, step.location, 'And/But must follow an explicit phase');
      if (child.background && phase !== 'Context') fail(uri, step.location, 'Background is setup-only');
      if (step.docString?.mediaType) fail(uri, step.location, 'typed Doc Strings are unsupported');
    }
    if (child.scenario) {
      const outline = node.keyword === 'Scenario Outline' || node.keyword === 'Scenario Template';
      if (outline && !node.examples.length) fail(uri, node.location, 'outline requires non-empty Examples with an id column');
      if (!outline && node.examples.length) fail(uri, node.location, 'Examples require a Scenario Outline');
      for (const examples of node.examples) {
        checkTags(examples.tags);
        const headers = examples.tableHeader?.cells.map((cell) => cell.value) ?? [];
        if (!headers.includes('id') || new Set(headers).size !== headers.length || !examples.tableBody.length) {
          fail(uri, examples.location, 'Examples require unique column names, an explicit id column and at least one row');
        }
        for (const row of examples.tableBody) {
          const values = Object.fromEntries(headers.map((header, i) => [header, row.cells[i]?.value]));
          if (!validId(values.id)) fail(uri, row.location, 'Examples id must be explicit kebab-case');
          rows.set(row.id, { values, location: row.location });
        }
      }
    }
  }
  if (!scenarios.size) fail(uri, feature.location, 'at least one Scenario required');

  const cases = [];
  const ids = new Set();
  for (const { pickle } of envelopes.filter((envelope) => envelope.pickle)) {
    const scenario = scenarios.get(pickle.astNodeIds[0]);
    const row = rows.get(pickle.astNodeIds[1]);
    const tags = pickle.tags.map((tag) => tag.name);
    const caseTags = tags.filter((tag) => tag.startsWith('@case:'));
    const activation = tags.filter((tag) => ['@should-trigger', '@should-not-trigger'].includes(tag));
    if (caseTags.length !== 1) fail(uri, scenario.location, 'exactly one @case:<id> tag required');
    if (activation.length !== 1) fail(uri, scenario.location, 'exactly one @should-trigger or @should-not-trigger tag required');
    const template = caseTags[0].slice(6);
    const id = row ? (template.includes('<id>') ? template.replaceAll('<id>', row.values.id) : row.values.id) : template;
    if (!validId(id)) fail(uri, row?.location ?? scenario.location, 'case id must be explicit kebab-case');
    if (ids.has(id)) fail(uri, row?.location ?? scenario.location, `duplicate case id ${id}`);
    ids.add(id);
    const c = {
      schemaVersion: 2,
      id,
      shouldTrigger: activation[0] === '@should-trigger',
      prompt: '',
      fixtures: false,
      checks: [],
      source: { uri, ...scenario.location, scenario: scenario.name, ...(row ? { examples: row.location } : {}), steps: [] },
    };
    let phase = 'Context';
    let prompts = 0;
    const checkNames = new Set();
    for (const step of pickle.steps) {
      const ast = nodes.get(step.astNodeIds[0]);
      try {
        const compiled = compileStep(step);
        if (compiled.phase !== step.type) throw new Error(`step belongs in ${compiled.phase}, not ${step.type}`);
        const order = { Context: 0, Action: 1, Outcome: 2 };
        if (order[compiled.phase] < order[phase]) throw new Error('phase order must be Given, When, Then');
        phase = compiled.phase;
        if (phase === 'Context') {
          if (c.fixtures) throw new Error('duplicate fixture setup');
          c.fixtures = compiled.value.fixtures;
        } else if (phase === 'Action') {
          if (++prompts !== 1) throw new Error('exactly one When prompt required');
          c.prompt = compiled.value.prompt;
          if (!c.prompt.trim()) throw new Error('exactly one non-empty prompt Doc String required');
        } else {
          if (prompts !== 1) throw new Error('Then requires a preceding When prompt');
          for (const value of compiled.value) {
            const check = nameCheck(value);
            if (checkNames.has(check.name)) throw new Error(`duplicate check name ${check.name}`);
            checkNames.add(check.name);
            c.checks.push(check);
            const problems = validateCase({ ...c, checks: [check] });
            if (problems.length) throw new Error(`invalid check ${check.name}: ${problems.join('; ')}`);
          }
        }
        c.source.steps.push({ ...ast.location, text: step.text, phase: compiled.phase });
      } catch (error) {
        fail(uri, ast.location, `${error.message}${row ? ` (Examples ${at(uri, row.location)})` : ''}`);
      }
    }
    if (prompts !== 1 || !c.prompt.trim()) fail(uri, scenario.location, 'exactly one non-empty prompt Doc String required');
    if (!c.checks.length) fail(uri, scenario.location, 'at least one Then check required');
    validate(c, uri, scenario.location);
    cases.push(c);
  }
  return cases;
}

function validateFixtures(suiteDir, c) {
  const root = resolve(suiteDir, 'fixtures');
  const location = c.source;
  let approved;
  try { approved = realpathSync(root); } catch {
    fail(location.uri, location, 'fixture setup requires the suite fixtures directory');
  }
  const inside = (path) => {
    const rel = relative(approved, realpathSync(path));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../'));
  };
  const seen = new Set();
  const walk = (path) => {
    if (!inside(path)) fail(location.uri, location, 'fixture path escapes the approved suite fixtures root');
    const actual = realpathSync(path);
    if (seen.has(actual)) fail(location.uri, location, 'cyclic or aliased fixture path');
    seen.add(actual);
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  if (approved !== root) fail(location.uri, location, 'suite fixtures root must not be a symbolic link');
  walk(root);
}

export function loadSuite(suiteDir) {
  const files = readdirSync(suiteDir).sort();
  const cases = [];
  const ids = new Map();
  const obsolete = files.find((name) => name.endsWith('.json') && !name.endsWith('.samples.json'));
  if (obsolete) fail(join(suiteDir, obsolete), undefined, 'JSON case definitions are unsupported; author cases in .feature files');
  for (const file of files.filter((name) => name.endsWith('.feature'))) {
    const uri = join(suiteDir, file);
    let loaded;
    try {
      loaded = compileFeature(readFileSync(uri, 'utf8'), { uri });
    } catch (error) {
      if (error.message.startsWith(uri)) throw error;
      fail(uri, undefined, error.message);
    }
    for (const c of loaded) {
      validate(c, uri, c.source);
      if (ids.has(c.id)) fail(uri, c.source, `duplicate case id ${c.id}; first defined in ${ids.get(c.id)}`);
      ids.set(c.id, uri);
      if (c.fixtures) validateFixtures(suiteDir, c);
      cases.push(c);
    }
  }
  const samples = new Set();
  for (const file of files.filter((name) => name.endsWith('.samples.json'))) {
    const uri = join(suiteDir, file);
    let sample;
    try { sample = JSON.parse(readFileSync(uri, 'utf8')); } catch (error) { fail(uri, undefined, error.message); }
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || Object.keys(sample).some((key) => !['caseId', 'pass', 'fail'].includes(key))
      || !validId(sample.caseId)
      || !['pass', 'fail'].every((key) => Array.isArray(sample[key]) && sample[key].length && sample[key].every((text) => typeof text === 'string' && text.length))) {
      fail(uri, undefined, 'samples must be { caseId, pass: non-empty string[], fail: non-empty string[] }');
    }
    const c = cases.find((candidate) => candidate.id === sample.caseId);
    if (!c) fail(uri, undefined, `orphan samples for ${sample.caseId}`);
    if (samples.has(c.id) || c.samples !== undefined) fail(uri, undefined, `duplicate samples for ${c.id}`);
    samples.add(c.id);
    c.samples = { pass: sample.pass, fail: sample.fail };
    validate(c, uri);
  }
  for (const c of cases) {
    if (!samples.has(c.id)) fail(c.source.uri, c.source, `feature case ${c.id} requires a *.samples.json sidecar`);
  }
  return cases;
}
