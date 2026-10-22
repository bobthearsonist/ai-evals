import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkills } from './copilot.mjs';

const INACTIVE_MCP_STATUSES = new Set(['disabled', 'not_configured', 'stopped']);
const isInactiveMcpStatus = (status) => INACTIVE_MCP_STATUSES.has(status);

export function sdkSessionConfig(request, onEvent) {
  const root = realpathSync(request.workspace);
  return {
    model: request.model,
    workingDirectory: root,
    trustWorkingDirectory: 'session',
    enableConfigDiscovery: false,
    enableSkills: true,
    includedBuiltinSkills: [],
    skillDirectories: [request.skillsRoot],
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    remoteSession: 'off',
    infiniteSessions: { enabled: false },
    customAgents: [],
    mcpServers: {},
    disabledMcpServers: ['github-mcp-server'],
    availableTools: ['builtin:skill', 'builtin:view', 'builtin:glob', 'builtin:rg'],
    sessionLimits: { maxAiCredits: request.maxAiCredits },
    onEvent,
    onPermissionRequest: (permission) => {
      if (permission.kind === 'read' && !permission.managedApprovalRequired && !permission.requestSandboxBypass
        && typeof permission.path === 'string') {
        const path = resolve(root, permission.path);
        if (existsSync(path)) {
          const inside = relative(root, realpathSync(path));
          if (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)) return { kind: 'approved' };
        }
      }
      return { kind: 'denied-by-rules' };
    },
  };
}

export function auditMcp(listing) {
  if (!Array.isArray(listing?.servers) || listing.servers.some((server) =>
    typeof server?.name !== 'string' || typeof server.enabled !== 'boolean'
    || typeof server.live?.status !== 'string')) {
    throw new Error('unsupported Copilot SDK MCP configuration listing');
  }
  const active = listing.servers.filter((server) => server.enabled || !isInactiveMcpStatus(server.live.status));
  if (active.length) throw new Error(`MCP discovery is not clean: ${active.map((server) => server.name).join(', ')}`);
}

// Inventory RPCs belong to the actual prompt session, not a separate CLI listing.
export async function runSdkSession(request, client, emit) {
  let session;
  let runtimeMcpError = null;
  try {
    await client.start();
    session = await client.createSession(sdkSessionConfig(request, (event) => {
      emit(event);
      if (event.type === 'session.mcp_servers_loaded'
        && (!Array.isArray(event.data?.servers) || event.data.servers.some((server) =>
          typeof server?.name !== 'string' || !isInactiveMcpStatus(server.status)))
        || event.type === 'session.mcp_server_status_changed' && !isInactiveMcpStatus(event.data?.status)
        || event.type === 'session.mcp_server_tools_loaded') {
        runtimeMcpError = 'unexpected runtime MCP server; session is contaminated';
      }
    }));
    const limits = await session.rpc.options.update({ sessionLimits: { maxAiCredits: request.maxAiCredits } });
    if (limits.success !== true) throw new Error('Copilot SDK did not apply session limits');
    const before = await session.rpc.skills.list();
    writeFileSync(request.auditPath, JSON.stringify(before, null, 2));
    auditSkills(before.skills, request.expected);
    const mcpBefore = await session.rpc.mcp.listConfigured();
    writeFileSync(`${request.auditPath}.mcp.json`, JSON.stringify(mcpBefore, null, 2));
    auditMcp(mcpBefore);
    if (runtimeMcpError) throw new Error(runtimeMcpError);
    // Conservatively count an attempted send even if admission subsequently fails.
    writeFileSync(request.startedPath, 'prompt attempted\n');
    await session.sendAndWait({ prompt: request.prompt }, request.timeoutMs);
    const after = await session.rpc.skills.list();
    writeFileSync(request.postAuditPath, JSON.stringify(after, null, 2));
    auditSkills(after.skills, request.expected);
    const mcpAfter = await session.rpc.mcp.listConfigured();
    writeFileSync(`${request.postAuditPath}.mcp.json`, JSON.stringify(mcpAfter, null, 2));
    auditMcp(mcpAfter);
    if (runtimeMcpError) throw new Error(runtimeMcpError);
    const usage = await session.rpc.usage.getMetrics();
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('unsupported Copilot SDK usage metrics');
    writeFileSync(request.usagePath, JSON.stringify(usage, null, 2));
  } finally {
    try {
      if (session) await session.disconnect();
    } finally {
      const errors = await client.stop();
      if (errors?.length) throw new AggregateError(errors, 'Copilot SDK runtime shutdown failed');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: request.exe, args: ['--disable-builtin-mcps', '--disallow-temp-dir'] }),
      baseDirectory: request.home,
      workingDirectory: request.workspace,
      useLoggedInUser: true,
    });
    await runSdkSession(request, client, (event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
