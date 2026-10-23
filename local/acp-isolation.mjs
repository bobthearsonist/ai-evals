import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function assertNoManagedClaudeSettings(resolved) {
  if (!resolved || typeof resolved.effective !== 'object' || resolved.effective === null) {
    throw new Error('Cannot verify managed Claude policy; refusing isolated ACP execution');
  }
  if (Object.keys(resolved.effective).length) {
    throw new Error('Managed Claude policy is active; isolated ACP execution is unsupported on this host');
  }
}

const SYSTEM_ENVIRONMENT = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'systemdrive',
  'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'term',
  'processor_architecture', 'number_of_processors',
]);

export function resolveAcpCredentials(client, {
  env = process.env,
  home = homedir(),
  read = readFileSync,
  exec = execFileSync,
  now = Date.now(),
} = {}) {
  if (client === 'copilot') {
    const configured = env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
    if (configured) return { COPILOT_GITHUB_TOKEN: configured };
    let token;
    try {
      token = exec('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
    } catch {
      throw new Error('Isolated Copilot ACP requires an existing gh sign-in or COPILOT_GITHUB_TOKEN; no login was attempted');
    }
    if (!token) throw new Error('Existing gh sign-in returned no token for isolated Copilot ACP');
    return { COPILOT_GITHUB_TOKEN: token };
  }
  if (client !== 'claude') throw new Error(`unsupported isolated ACP client: ${client}`);
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN };
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  let credentials;
  try {
    credentials = JSON.parse(read(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'), 'utf8'));
  } catch {
    throw new Error('Isolated Claude ACP requires CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or an existing .claude credential file; no login was attempted');
  }
  const oauth = credentials.claudeAiOauth;
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken
    || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now) {
    throw new Error('Existing Claude OAuth credential is missing or expired; refresh it in the native client before retrying');
  }
  return { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken };
}

// Credentials travel only in the child's environment, never in its workspace,
// command line, launch description, archive, or temporary configuration files.
export function prepareAcpEnvironment(client, { env = process.env, credentials = resolveAcpCredentials(client, { env }) } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ai-evals-acp-home-'));
  try {
    const claude = join(home, '.claude');
    const copilot = join(home, '.copilot');
    const config = join(home, '.config');
    for (const directory of [claude, copilot, config, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) {
      mkdirSync(directory, { recursive: true });
    }

    writeFileSync(join(claude, 'settings.json'), JSON.stringify({
      permissions: { defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable' },
      disableAllHooks: true,
    }));
    writeFileSync(join(copilot, 'config.json'), JSON.stringify({}));
    const system = Object.fromEntries(Object.entries(env).filter(([key]) => SYSTEM_ENVIRONMENT.has(key.toLowerCase())));
    return {
      home,
      env: {
        ...system,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        CLAUDE_CONFIG_DIR: claude,
        COPILOT_HOME: copilot,
        COPILOT_AUTO_UPDATE: 'false',
        ...credentials,
      },
      cleanup() { rmSync(home, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

export function checkAcpRuntime(launch) {
  if (!launch.isolatedClient) return { authentication: 'not checked; explicit custom profile' };
  if (launch.isolatedClient === 'copilot') {
    const isolated = prepareAcpEnvironment('copilot', { credentials: {} });
    try {
      let version;
      try {
        version = execFileSync(launch.command, ['--version', '--no-auto-update'], {
          env: isolated.env, encoding: 'utf8', timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (error) {
        throw new Error(
          `Copilot ACP executable "${launch.command}" is not runnable; verify the CLI is installed and available at that path or on PATH, or pass its native executable with --exe. ${error.message}`,
          { cause: error },
        );
      }
      if (!new RegExp(`\\b${launch.expectedAgentVersion.replaceAll('.', '\\.')}\\b`).test(version)) {
        throw new Error(`Copilot ACP executable "${launch.command}" must be CLI version ${launch.expectedAgentVersion}`);
      }
    } finally { isolated.cleanup(); }
  } else {
    const isolated = prepareAcpEnvironment('claude', { credentials: {} });
    try {
      const version = execFileSync(launch.command, [...launch.args, '--version'], {
        env: isolated.env, encoding: 'utf8', timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      if (version.trim() !== launch.expectedAgentVersion) throw new Error('Pinned Claude ACP adapter version mismatch');
    } catch (error) {
      throw new Error(
        `Claude ACP runtime check failed for Node executable "${launch.command}" and adapter "${launch.args[0]}": ${error.message}. Run "node ${launch.args[0]} --version" locally and verify the pinned adapter version and managed-policy settings.`,
        { cause: error },
      );
    } finally { isolated.cleanup(); }
  }
  resolveAcpCredentials(launch.isolatedClient);
  return { authentication: 'existing credential available; provider access not checked; no model call made' };
}
