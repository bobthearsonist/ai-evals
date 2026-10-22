// Synthetic subprocess protocol fixture. This executable never contacts a model or service.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args.includes('--help')) {
  console.log('--prompt --output-format --model --no-ask-user --no-custom-instructions --disable-builtin-mcps --no-auto-update --available-tools --allow-tool --max-ai-credits --usage-output-file --trust-folder --disallow-temp-dir');
} else if (args.includes('--version')) {
  console.log('synthetic-copilot 1.0.0');
} else if (args.includes('disable')) {
  if (process.env.FAKE_COPILOT_MODE === 'builtin-disable-failure') {
    console.error('synthetic disable failure');
    process.exitCode = 1;
  } else {
    writeFileSync(join(process.env.COPILOT_HOME, 'disabled-builtin'), 'true');
    console.log('disabled');
  }
} else if (args.includes('list')) {
  const dir = join(process.cwd(), '.github', 'skills');
  const skills = existsSync(dir) ? readdirSync(dir).map((name) => ({ name, path: join(dir, name), enabled: true, source: 'project' })) : [];
  if (process.env.FAKE_COPILOT_MODE === 'foreign') skills.push({ name: 'foreign', path: process.cwd(), enabled: true });
  if (process.env.FAKE_COPILOT_MODE?.startsWith('builtin')) {
    skills.push({
      name: 'bundled', path: process.cwd(), source: 'builtin',
      enabled: !existsSync(join(process.env.COPILOT_HOME, 'disabled-builtin')),
    });
  }
  console.log(JSON.stringify(skills));
} else if (args.includes('-p')) {
  const prompt = option('-p');
  const skillDir = join(process.cwd(), '.github', 'skills');
  const names = existsSync(skillDir) ? readdirSync(skillDir) : [];
  const hasSkill = names.length === 1;
  const mode = process.env.FAKE_COPILOT_MODE;
  const log = (kind) => {
    if (process.env.FAKE_COPILOT_LOG) appendFileSync(process.env.FAKE_COPILOT_LOG, JSON.stringify({
      kind, pid: process.pid, at: Date.now(), cwd: process.cwd(), home: process.env.COPILOT_HOME,
      hasSkill, prompt, files: readdirSync(process.cwd()),
      skillContent: hasSkill ? readFileSync(join(skillDir, names[0], 'SKILL.md'), 'utf8') : null,
    }) + '\n');
  };
  const event = (type, data) => console.log(JSON.stringify({ type, data }));
  log('start');
  if (mode === 'hang') {
    if (process.env.FAKE_COPILOT_CHILD_PID_FILE) {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      writeFileSync(process.env.FAKE_COPILOT_CHILD_PID_FILE, String(child.pid));
    }
    setTimeout(() => {}, 60_000);
  } else {
    if (mode === 'auth') {
      event('session.error', { errorType: 'authentication', message: 'sign in required' });
      event('session.idle', {});
      process.exitCode = 1;
    } else {
      const skills = names.map((name) => ({ name, path: join(skillDir, name), enabled: true, source: 'project' }));
      if (mode === 'runtime-foreign') skills.push({ name: 'foreign', path: process.cwd(), enabled: true, source: 'builtin' });
      if (mode?.startsWith('builtin') && (mode === 'builtin-runtime-mismatch' || !existsSync(join(process.env.COPILOT_HOME, 'disabled-builtin')))) {
        skills.push({ name: 'bundled', path: process.cwd(), enabled: true, source: 'builtin' });
      }
      if (mode !== 'runtime-missing') event('session.skills_loaded', { skills });
      if (hasSkill && prompt.includes('[invoke]')) {
        event('tool.execution_start', { toolName: 'skill', toolCallId: 'skill-1', arguments: { skill: names[0] } });
        event('tool.execution_complete', { toolCallId: 'skill-1', success: true, result: { content: 'synthetic skill loaded' } });
      }
      if (prompt.includes('{{fixtures}}')) throw new Error('fixtures path was not substituted');
      event('assistant.message', { content: hasSkill ? 'hello' : 'goodbye' });
      if (mode !== 'truncated') console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
      if (mode === 'bad-json') console.log('not JSON');
      if (mode === 'exit-failure') process.exitCode = 1;
    }
    if (mode !== 'missing-usage') writeFileSync(option('--usage-output-file'), JSON.stringify({ synthetic: true, totalNanoAiu: 1000 }));
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_COPILOT_DELAY ?? 0)));
    log('end');
  }
} else {
  console.error('unsupported synthetic command');
  process.exitCode = 64;
}
