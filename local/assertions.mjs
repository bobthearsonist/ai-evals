import { validateV2CheckSchema } from './schema.mjs';

const checkName = (check) => check?.name ?? check?.pattern ?? check?.type ?? 'unnamed-check';

function invalid(check, diagnostic) {
  return { name: checkName(check), passed: null, diagnostic };
}

function selectedText(check, transcript) {
  const target = check.target ?? 'last_message';
  if (target === 'trace') {
    if (typeof transcript?.raw !== 'string') return { diagnostic: 'trace evidence is missing' };
    return { text: transcript.raw };
  }
  if (typeof transcript?.finalText !== 'string') return { diagnostic: 'final message evidence is missing' };
  if (target === 'commit_subject') {
    const subject = extractCommitSubject(transcript.finalText);
    return subject.error ? { failedDiagnostic: subject.error } : { text: subject.subject };
  }
  return { text: transcript.finalText };
}

export function extractCommitSubject(message) {
  if (typeof message !== 'string' || !message.length) return { error: 'commit message is missing' };

  const fences = [...message.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g)];
  if (fences.length > 1) return { error: 'commit message is ambiguous: multiple fenced messages were provided' };

  let candidate = message;
  if (fences.length === 1) {
    const fence = fences[0];
    const outside = `${message.slice(0, fence.index)}${message.slice(fence.index + fence[0].length)}`;
    if (/```/.test(outside)) return { error: 'commit message is ambiguous: malformed fenced content' };
    candidate = fence[2];
  } else if (/```/.test(message)) {
    return { error: 'commit message is ambiguous: malformed fenced content' };
  }

  if (/^\s*(?:suggested commit messages?|options?)\s*:|^\s*(?:option|suggestion)\s+\d+\b/im.test(candidate)) {
    return { error: 'commit message is ambiguous: multiple suggestions were provided' };
  }
  if (candidate.split(/\r?\n/).filter((line) => parseConventionalHeader(line)).length > 1) {
    return { error: 'commit message is ambiguous: multiple commit subjects were provided' };
  }

  const subject = candidate.split(/\r?\n/, 1)[0];
  if (!subject) return { error: 'commit message subject is missing' };
  return { subject };
}

function parseConventionalHeader(subject) {
  const match = /^([a-z][a-z0-9-]*)(?:\(([^()\s]+)\))?(!)?: ([^\r\n]+)$/.exec(subject);
  if (!match) return null;
  return { type: match[1], scope: match[2] ?? null, breaking: Boolean(match[3]), description: match[4] };
}

function isLowercaseInitial(text) {
  const initial = [...text][0];
  return initial !== undefined && /^\p{Ll}$/u.test(initial);
}

export function evaluateCheck(check, transcript) {
  const problems = validateV2CheckSchema(check);
  if (problems.length) return invalid(check, `invalid check: ${problems.join('; ')}`);
  const name = checkName(check);

  if (check.type === 'tool_order') {
    if (!Array.isArray(transcript?.toolCalls)) return invalid(check, 'tool-call evidence is missing');
    if (!transcript.toolCalls.every((call) => call && typeof call.name === 'string')) {
      return invalid(check, 'tool-call evidence is malformed');
    }
    const index = (toolName) => transcript.toolCalls.findIndex((call) => call?.name === toolName);
    const before = index(check.before);
    const after = index(check.after);
    return { name, passed: before !== -1 && after !== -1 && before < after };
  }

  if (check.type === 'file_exists') {
    const files = Array.isArray(transcript?.fileSnapshot)
      ? transcript.fileSnapshot
      : transcript?.fileSnapshot?.files ?? transcript?.files;
    if (!Array.isArray(files)) return invalid(check, 'file snapshot evidence is missing');
    if (!files.every((path) => typeof path === 'string')) return invalid(check, 'file snapshot evidence is malformed');
    return { name, passed: files.includes(check.path) };
  }

  const selected = selectedText(check, transcript);
  if (selected.diagnostic) return invalid(check, selected.diagnostic);
  if (selected.failedDiagnostic) {
    return { name, passed: false, diagnostic: selected.failedDiagnostic };
  }
  const text = selected.text;

  if (check.type === 'contains') return { name, passed: text.includes(check.value) };
  if (check.type === 'not_contains') return { name, passed: !text.includes(check.value) };
  if (check.type === 'starts_with') return { name, passed: text.startsWith(check.value) };
  if (check.type === 'max_length') return { name, passed: [...text].length <= check.limit };
  if (check.type === 'length_less_than') return { name, passed: [...text].length < check.limit };
  if (check.type === 'regex' || check.type === 'not_regex') {
    const match = new RegExp(check.pattern, check.flags ?? '').test(text);
    return { name, passed: check.type === 'regex' ? match : !match };
  }

  if (check.type === 'lowercase_initial') {
    const header = parseConventionalHeader(text);
    return { name, passed: isLowercaseInitial(header?.description ?? text) };
  }
  if (check.type === 'conventional_header') {
    const header = parseConventionalHeader(text);
    return { name, passed: header !== null && check.types.includes(header.type) };
  }

  return invalid(check, `unsupported check type "${check.type}"`);
}
