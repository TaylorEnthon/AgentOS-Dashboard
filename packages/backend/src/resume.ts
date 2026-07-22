/**
 * Resume-command generator. PURE function — generates the command
 * string, never executes it. The caller is responsible for any
 * safety considerations before pasting the command into a shell.
 *
 * The id passed to the CLI is `externalId` (the upstream agent's
 * own session UUID), NOT the composite AgentOS id (`agentId:externalId`).
 * That keeps the command portable: it works whether or not
 * AgentOS is installed.
 */

import type { AgentType, ResumeCommand } from '@agentos/shared';

export function buildResumeCommand(
  agentType: AgentType,
  externalId: string,
): ResumeCommand {
  switch (agentType) {
    case 'claude-code':
      return {
        agent: agentType,
        command: `claude --resume ${shellQuote(externalId)}`,
        externalId,
        notes:
          'Claude Code CLI: `claude --resume <sessionId>`. ' +
          'Run this from the same project directory the session was started in.',
      };
    case 'codex':
      return {
        agent: agentType,
        command: `codex resume ${shellQuote(externalId)}`,
        externalId,
        notes:
          'Codex CLI: `codex resume <threadId>`. ' +
          'The thread id matches the UUID in the rollout file name.',
      };
    case 'grok':
      return {
        agent: agentType,
        command: `grok --resume ${shellQuote(externalId)}`,
        externalId,
        notes:
          'Grok CLI: `grok --resume <sessionId>`. ' +
          'Verify the exact flag spelling with `grok --help` for your installed version.',
      };
    case 'gemini':
    case 'hermes':
    case 'custom':
      return {
        agent: agentType,
        command: `# Resume not yet supported for ${agentType}`,
        externalId,
        notes: 'This agent does not have a known resume command.',
      };
  }
}

/**
 * Minimal shell quoting — wraps the id in single quotes if it
 * contains characters that would otherwise need escaping. Most
 * session ids are UUIDs (alphanumeric + dashes), so the common
 * case is no quoting at all.
 */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9._\-:]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}