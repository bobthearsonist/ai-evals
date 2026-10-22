const JUDGE_ISOLATION = Object.freeze({
  profile: 'ai-evals-judge',
  enforced: true,
  tools: false,
  skills: false,
  mcp: false,
});

const KNOWN_CAPABILITIES = new Set([
  'tool-free',
  'skills-free',
  'mcp-free',
  'tool-exclusion',
  'skill-exclusion',
  'mcp-exclusion',
  'fixed-model',
  'session-cancel',
]);
const BUILT_LAUNCHES = new WeakSet();

function mergeJudgeMeta(sessionMeta, model) {
  const supplied = sessionMeta ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new TypeError('sessionMeta must be an object');
  }
  for (const key of Object.keys(supplied)) {
    if (!['aiEvals', 'disableBuiltInTools', 'claudeCode'].includes(key)) {
      throw new Error(`ai-evals-judge does not allow session metadata key ${key}`);
    }
  }
  if (supplied.claudeCode && Object.keys(supplied.claudeCode).some((key) => key !== 'options')) {
    throw new Error('ai-evals-judge only accepts claudeCode.options metadata');
  }

  const existing = supplied.claudeCode?.options ?? {};
  const allowedOptions = new Set(['model', 'tools', 'settingSources', 'strictMcpConfig']);
  for (const key of Object.keys(existing)) {
    if (!allowedOptions.has(key)) throw new Error(`ai-evals-judge does not allow claudeCode.options.${key}`);
  }
  const expected = {
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    ...(model ? { model } : {}),
  };
  for (const key of ['tools', 'settingSources', 'strictMcpConfig']) {
    if (Object.hasOwn(existing, key) && JSON.stringify(existing[key]) !== JSON.stringify(expected[key])) {
      throw new Error(`ai-evals-judge does not allow overriding claudeCode.options.${key}`);
    }
  }
  if (model && Object.hasOwn(existing, 'model') && existing.model !== model) {
    throw new Error('ai-evals-judge model conflicts with sessionMeta');
  }
  if (Object.hasOwn(supplied, 'disableBuiltInTools') && supplied.disableBuiltInTools !== true) {
    throw new Error('ai-evals-judge does not allow overriding disableBuiltInTools');
  }

  return {
    ...supplied,
    disableBuiltInTools: true,
    claudeCode: {
      ...supplied.claudeCode,
      options: { ...existing, ...expected },
    },
  };
}

function capabilitiesFor(client, profile) {
  if (profile === 'ai-evals-judge' && client === 'claude') {
    return {
      toolFree: true,
      skillsFree: true,
      mcpFree: true,
      fixedModel: true,
      sessionCancel: true,
    };
  }

  return {
    toolFree: false,
    skillsFree: false,
    mcpFree: false,
    fixedModel: ['copilot', 'opencode', 'claude'].includes(client),
    sessionCancel: true,
  };
}

function capabilityValue(capabilities, name) {
  return {
    'tool-free': capabilities.toolFree,
    'skills-free': capabilities.skillsFree,
    'mcp-free': capabilities.mcpFree,
    'tool-exclusion': capabilities.toolFree,
    'skill-exclusion': capabilities.skillsFree,
    'mcp-exclusion': capabilities.mcpFree,
    'fixed-model': capabilities.fixedModel,
    'session-cancel': capabilities.sessionCancel,
  }[name];
}

export function validateAcpProfile({
  client,
  mode = 'candidate',
  model,
  cwd,
  profile,
  requiredCapabilities = [],
  command,
  args,
  env,
  sessionMeta,
  mcpServers,
} = {}) {
  const selectedProfile = profile ?? (client === 'custom' ? 'custom' : client);
  const errors = [];
  if (!['candidate', 'judge'].includes(mode)) errors.push(`unsupported ACP mode: ${mode}`);
  if (!['copilot', 'opencode', 'claude', 'custom'].includes(client)) errors.push(`unsupported ACP client: ${client}`);
  if (typeof cwd !== 'string' || !cwd || !isAbsolutePath(cwd)) errors.push('cwd must be an absolute path');
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) errors.push('model must be a non-empty string');
  if (mcpServers !== undefined && !Array.isArray(mcpServers)) errors.push('mcpServers must be an array');
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((capability) => typeof capability !== 'string')) {
    errors.push('requiredCapabilities must be an array of capability names');
  }

  const capabilities = capabilitiesFor(client, selectedProfile);
  if (mode === 'judge' && selectedProfile !== 'ai-evals-judge') {
    errors.push('judge mode requires the ai-evals-judge profile');
  }
  if (mode === 'candidate' && ['copilot', 'opencode', 'claude'].includes(selectedProfile)) {
    errors.push(`native ${selectedProfile} candidate profile has no verified ambient skills/MCP isolation; use an explicitly configured custom ACP profile`);
  }
  if (selectedProfile === 'ai-evals-judge') {
    if (client !== 'claude') errors.push('ai-evals-judge is available only for the Claude ACP adapter');
    if (mode !== 'judge') errors.push('ai-evals-judge requires mode: judge');
    if (!model) errors.push('ai-evals-judge requires an explicit model');
    if (command || args) errors.push('ai-evals-judge does not allow command or args overrides');
    if (mcpServers?.length) errors.push('ai-evals-judge does not allow ACP MCP servers');
  } else if (selectedProfile === 'custom' && (!command || !Array.isArray(args))) {
    errors.push('custom ACP profile requires command and args');
  } else if (selectedProfile !== 'custom' && !['copilot', 'opencode', 'claude'].includes(selectedProfile)) {
    errors.push(`unsupported ACP profile: ${selectedProfile}`);
  }

  const requirements = Array.isArray(requiredCapabilities) ? requiredCapabilities : [];
  for (const requirement of requirements) {
    if (!KNOWN_CAPABILITIES.has(requirement)) {
      errors.push(`unknown required ACP capability: ${requirement}`);
    } else if (!capabilityValue(capabilities, requirement)) {
      errors.push(`ACP profile ${selectedProfile} does not provide required capability: ${requirement}`);
    }
  }

  let launchCommand = command;
  let launchArgs = args ? [...args] : [];
  let launchMeta = sessionMeta ?? {};
  if (!errors.length) {
    try {
      if (selectedProfile === 'ai-evals-judge') {
        launchCommand = 'claude-agent-acp';
        launchArgs = [];
        launchMeta = mergeJudgeMeta(sessionMeta, model);
      } else if (selectedProfile === 'copilot') {
        launchCommand ??= 'copilot';
        launchArgs = [...launchArgs, '--acp', '--stdio'];
        if (model) launchArgs.push('--model', model);
      } else if (selectedProfile === 'opencode') {
        launchCommand ??= 'opencode';
        if (model) launchArgs.push('--model', model);
        launchArgs.push('acp');
      } else if (selectedProfile === 'claude') {
        launchCommand ??= 'claude-agent-acp';
        if (model) {
          const claudeCode = sessionMeta?.claudeCode ?? {};
          const options = claudeCode.options ?? {};
          if (options.model && options.model !== model) throw new Error('Claude ACP model conflicts with sessionMeta');
          launchMeta = { ...sessionMeta, claudeCode: { ...claudeCode, options: { ...options, model } } };
        }
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env))) {
    errors.push('env must be an object');
  }

  return {
    valid: errors.length === 0,
    client,
    mode,
    profile: selectedProfile,
    ...(launchCommand ? { command: launchCommand } : {}),
    args: launchArgs,
    cwd,
    ...(env ? { env: { ...env } } : {}),
    sessionMeta: launchMeta,
    mcpServers: mcpServers ?? [],
    model: model ?? null,
    ...(selectedProfile === 'ai-evals-judge' && client === 'claude' && mode === 'judge' && !errors.length
      ? { expectedAgentVersion: '0.94.0' }
      : {}),
    capabilities,
    ...(selectedProfile === 'ai-evals-judge' && client === 'claude' && mode === 'judge' && !errors.length
      ? { judgeIsolation: { ...JUDGE_ISOLATION } }
      : {}),
    modelAtLaunch: ['copilot', 'opencode', 'claude', 'ai-evals-judge'].includes(selectedProfile),
    errors,
  };
}

export function buildAcpLaunch(options = {}) {
  const validation = validateAcpProfile(options);
  if (!validation.valid) {
    throw new Error(`Invalid ACP profile: ${validation.errors.join('; ')}`);
  }
  if (!validation.command) throw new Error('ACP profile did not resolve a command');
  if (typeof options.prompt !== 'string' || !options.prompt) throw new TypeError('ACP prompt is required');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('ACP timeoutMs must be positive');

  const launch = structuredClone({
    ...validation,
    prompt: options.prompt,
    timeoutMs,
    ...(options.mcpServers ? { mcpServers: [...options.mcpServers] } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
  });
  freezeDeep(launch);
  BUILT_LAUNCHES.add(launch);
  return launch;
}

function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function isBuiltAcpLaunch(options) {
  return Boolean(options && BUILT_LAUNCHES.has(options));
}
