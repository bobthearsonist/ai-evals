import { createHash } from 'node:crypto';
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';

const parameters = new ParameterTypeRegistry();
const definitions = [];
const add = (expression, phase, argument, build, named = false) => {
  definitions.push({ expression: new CucumberExpression(expression, parameters), phase, argument, build });
  if (named) {
    definitions.push({
      expression: new CucumberExpression(`${expression} named {string}`, parameters),
      phase,
      argument,
      build: (...values) => {
        const name = values.pop();
        return build(...values).map((check) => ({ ...check, name }));
      },
    });
  }
};

add('the suite fixtures are available', 'Context', 'none', () => ({ fixtures: true }));
add('the user asks:', 'Action', 'docString', (doc) => ({ prompt: doc }));
add('the AI judge confirms:', 'Outcome', 'docString',
  (text) => ({ judgeCriteria: [{ text }] }));
add('the AI judge confirms {string}:', 'Outcome', 'docString',
  (id, text) => ({ judgeCriteria: [{ id, text }] }));

const judgeActions = new Map([
  ['identifies', 'The response must recognize the specified problem, concept, or fact. Merely repeating the question does not establish recognition.'],
  ['recommends', 'The response must advise the specified course of action. Merely describing an option or quoting someone else\'s advice is insufficient.'],
  ['explains', 'The response must explain the specified relationship or rationale. Mentioning its components without connecting them is insufficient.'],
  ['conditions', 'The response must make the specified action dependent on the specified prerequisite. Mentioning the action and prerequisite separately is insufficient.'],
  ['does not endorse', 'The response must not advocate the specified position anywhere in the answer. Merely quoting, discussing, or rejecting that position is not endorsement. The response need not explicitly reject or mention it to satisfy this criterion.'],
]);

add('the AI judge verifies:', 'Outcome', 'dataTable', (table) => {
  const [header, ...rows] = table.rows;
  const columns = ['id', 'action', 'expectation'];
  if (!header || header.cells.length !== columns.length
    || header.cells.some((cell, i) => cell.value !== columns[i])
    || !rows.length || rows.some((row) => row.cells.length !== columns.length)) {
    throw new Error('AI judge verifies requires an id, action, expectation header and at least one three-column row');
  }
  return {
    judgeCriteria: rows.map((row, i) => {
      const [id, action, expectation] = row.cells.map((cell) => cell.value.trim());
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        throw new Error(`AI judge verifies row ${i + 1} requires an explicit kebab-case id`);
      }
      if (!judgeActions.has(action)) {
        throw new Error(`AI judge verifies row ${i + 1} has unsupported action "${action}"; expected one of: ${[...judgeActions.keys()].join(', ')}`);
      }
      if (!expectation) throw new Error(`AI judge verifies row ${i + 1} requires a non-empty expectation`);
      return { id, text: `${judgeActions.get(action)}\nExpectation: ${expectation}` };
    }),
  };
});

for (const [verb, type] of [['contains', 'contains'], ['does not contain', 'not_contains'], ['starts with', 'starts_with']]) {
  add(`the response ${verb} {string}`, 'Outcome', 'none',
    (value) => [{ type, target: 'last_message', value }], true);
}
add('the response contains each row:', 'Outcome', 'dataTable', (table) => {
  if (!table.rows.length || table.rows.some((row) => row.cells.length !== 1)) {
    throw new Error('contains each row requires a non-empty, one-column table without a header');
  }
  return table.rows.map((row) => ({ type: 'contains', target: 'last_message', value: row.cells[0].value }));
});
for (const [subject, target] of [['response', 'last_message'], ['commit subject', 'commit_subject']]) {
  for (const [phrase, type] of [['is at most', 'max_length'], ['is shorter than', 'length_less_than']]) {
    add(`the ${subject} ${phrase} {int} characters`, 'Outcome', 'none',
      (limit) => [{ type, target, limit }], true);
  }
  for (const [phrase, type] of [['matches', 'regex'], ['does not match', 'not_regex']]) {
    add(`the ${subject} ${phrase} regex named {string} with flags {string}:`, 'Outcome', 'docString',
      (name, flags, pattern) => [{ type, name, target, pattern, flags }]);
  }
}
add('the commit subject uses a conventional header with types {string}', 'Outcome', 'none',
  (types) => [{ type: 'conventional_header', target: 'commit_subject', types: types.split(',').map((type) => type.trim()) }], true);
add('the commit subject description starts with a lowercase letter', 'Outcome', 'none',
  () => [{ type: 'lowercase_initial', target: 'commit_subject' }], true);
add('the response calls tools in order {string} then {string}', 'Outcome', 'none',
  (before, after) => [{ type: 'tool_order', before, after }], true);
add('the file snapshot contains {string}', 'Outcome', 'none',
  (path) => [{ type: 'file_exists', path }], true);

export function compileStep(step) {
  const matches = definitions.flatMap((definition) => {
    const args = definition.expression.match(step.text);
    return args === null ? [] : [{ definition, values: args.map((arg) => arg.getValue(null)) }];
  });
  if (matches.length !== 1) throw new Error(`${matches.length ? 'ambiguous' : 'unknown'} step: ${step.text}`);
  const { definition, values } = matches[0];
  const argument = step.argument;
  if (definition.argument === 'none' ? argument !== undefined : !argument?.[definition.argument]) {
    throw new Error(`step requires ${definition.argument === 'none' ? 'no argument' : `a ${definition.argument}`}: ${step.text}`);
  }
  if (definition.argument === 'docString') {
    if (argument.docString.mediaType) throw new Error('typed Doc Strings are unsupported');
    values.push(argument.docString.content);
  } else if (definition.argument === 'dataTable') {
    values.push(argument.dataTable);
  }
  return { phase: definition.phase, value: definition.build(...values) };
}

export function nameCheck(check) {
  if (check.name !== undefined) return check;
  const semantic = Object.fromEntries(Object.entries(check).sort(([a], [b]) => a.localeCompare(b)));
  const hash = createHash('sha256').update(JSON.stringify(semantic)).digest('hex').slice(0, 12);
  return { ...check, name: `${check.type}-${check.target}-${hash}`.replaceAll('_', '-') };
}

export function nameCriterion(criterion) {
  return {
    ...criterion,
    id: criterion.id ?? `meaning-${createHash('sha256').update(criterion.text).digest('hex').slice(0, 12)}`,
  };
}
