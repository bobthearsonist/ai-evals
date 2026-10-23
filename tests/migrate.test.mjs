import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite } from '../local/suite.mjs';
import { validateCase } from '../local/contract.mjs';
import { migrateJsonCases } from '../local/migrate.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(root, 'fixtures', 'migrate', 'legacy-cases');

function roundTrip(sourceDir) {
  const outputDir = join(root, 'fixtures', 'migrate', `.round-trip-${process.pid}-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  try {
    const converted = migrateJsonCases(sourceDir);
    writeFileSync(join(outputDir, 'cases.feature'), converted.feature);
    for (const sample of converted.samples) {
      writeFileSync(join(outputDir, sample.fileName), `${JSON.stringify(sample.content, null, 2)}\n`);
    }
    return { ...converted, cases: loadSuite(outputDir) };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

test('legacy JSON conversion round-trips through loadSuite and validateCase', () => {
  const converted = roundTrip(fixtureDir);
  assert.equal(converted.cases.length, 1);
  assert.deepEqual(converted.cases.map(validateCase), [[]]);
  assert.equal(converted.cases[0].id, 'my-case');
  assert.deepEqual(converted.cases[0].checks.map((check) => check.name), ['has-summary', 'has-summary-2', 'output-file', 'tools-order']);
  assert.deepEqual(converted.samples[0], {
    fileName: 'my-case.samples.json',
    content: { caseId: 'my-case', pass: ['Summary: implemented.'], fail: ['No details here.'] },
  });
  assert.ok(converted.warnings.some((warning) => warning.includes('my-case')));
  assert.ok(converted.warnings.some((warning) => warning.includes('has-summary-2')));
});

const realLegacySuite = 'C:\\Repositories\\profisee-ai\\evals\\cases\\profisee-sonar';
test('a real profisee-ai legacy suite migrates and loads when present', { skip: !existsSync(realLegacySuite) }, () => {
  const converted = roundTrip(realLegacySuite);
  assert.ok(converted.cases.length > 0);
  assert.deepEqual(converted.cases.map(validateCase), converted.cases.map(() => []));
  assert.equal(converted.samples.length, converted.cases.length);
  assert.ok(readFileSync(join(realLegacySuite, 'csharp-prepush-routing.json'), 'utf8').includes('schemaVersion'));
});
