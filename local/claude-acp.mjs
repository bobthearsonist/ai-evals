import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { assertNoManagedClaudeSettings } from './acp-isolation.mjs';

// Managed policy is outside the temporary HOME and cannot be overridden safely.
assertNoManagedClaudeSettings(await resolveSettings({ settingSources: [] }));
if (!process.argv.includes('--check')) {
  await import('@agentclientprotocol/claude-agent-acp/dist/index.js');
}
