import Ajv from 'ajv';

const checkTypes = [
  'contains',
  'not_contains',
  'starts_with',
  'max_length',
  'length_less_than',
  'conventional_header',
  'lowercase_initial',
  'regex',
  'not_regex',
  'file_exists',
  'tool_order',
];

const checkSchema = {
  $id: 'https://ai-evals.local/schema/v2-check.json',
  type: 'object',
  required: ['type', 'name'],
  properties: {
    type: { enum: checkTypes },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    target: { enum: ['last_message', 'trace', 'commit_subject'] },
    value: { type: 'string' },
    limit: { type: 'integer' },
    types: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    },
    pattern: { type: 'string' },
    flags: { type: 'string' },
    path: { type: 'string', minLength: 1 },
    before: { type: 'string', minLength: 1 },
    after: { type: 'string', minLength: 1 },
  },
  allOf: [
    {
      if: { properties: { type: { enum: ['contains', 'not_contains', 'starts_with'] } }, required: ['type'] },
      then: { required: ['value'] },
    },
    {
      if: { properties: { type: { enum: ['max_length', 'length_less_than'] } }, required: ['type'] },
      then: { required: ['limit'] },
    },
    {
      if: { properties: { type: { const: 'conventional_header' } }, required: ['type'] },
      then: { required: ['types'] },
    },
    {
      if: { properties: { type: { enum: ['regex', 'not_regex'] } }, required: ['type'] },
      then: { required: ['pattern'] },
    },
    {
      if: { properties: { type: { const: 'file_exists' } }, required: ['type'] },
      then: { required: ['path'] },
    },
    {
      if: { properties: { type: { const: 'tool_order' } }, required: ['type'] },
      then: { required: ['before', 'after'] },
    },
  ],
  additionalProperties: false,
};

const caseSchema = {
  $id: 'https://ai-evals.local/schema/v2-case.json',
  type: 'object',
  required: ['schemaVersion', 'id', 'prompt', 'shouldTrigger', 'checks'],
  properties: {
    schemaVersion: { const: 2 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    prompt: { type: 'string', minLength: 1, pattern: '\\S' },
    shouldTrigger: { type: 'boolean' },
    checks: { type: 'array', minItems: 1, items: { $ref: checkSchema.$id } },
    fixtures: { type: 'boolean' },
    samples: {
      type: 'object',
      required: ['pass', 'fail'],
      properties: {
        pass: { type: 'array', items: { type: 'string' } },
        fail: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(checkSchema);
const validateCheckSchema = ajv.compile({ $ref: checkSchema.$id });
const validateCaseSchema = ajv.compile(caseSchema);

function formatErrors(errors = []) {
  return errors.filter((error) => error.keyword !== 'if').map((error) => {
    const path = error.instancePath || '/';
    return `${path} ${error.message}`;
  });
}

export function validateV2CheckSchema(check) {
  const problems = [];
  if (!validateCheckSchema(check)) problems.push(...formatErrors(validateCheckSchema.errors));
  if (check && typeof check === 'object' && ['regex', 'not_regex'].includes(check.type) &&
      typeof check.pattern === 'string') {
    try {
      new RegExp(check.pattern, check.flags ?? '');
    } catch (error) {
      problems.push(`invalid regular expression: ${error.message}`);
    }
  }
  return problems;
}

export function validateV2CaseSchema(c) {
  if (!validateCaseSchema(c)) return formatErrors(validateCaseSchema.errors);
  return [];
}
