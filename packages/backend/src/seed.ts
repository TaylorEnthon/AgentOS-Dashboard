import { buildCollector } from '@agentos/collectors';
import type { AgentType } from '@agentos/shared';
import { Db } from './db.js';

/**
 * Walks every known collector, resolves their data dirs, and upserts
 * the agent descriptors into SQLite so the UI can enumerate them.
 */
export async function seedAgents(db: Db): Promise<void> {
  const types: AgentType[] = ['claude-code', 'codex', 'grok', 'gemini', 'hermes'];
  for (const t of types) {
    const collector = buildCollector(t);
    try {
      const agent = await collector.describe();
      if (agent) {
        db.upsertAgent({
          id: agent.id,
          name: agent.name,
          type: agent.type,
          dataDir: agent.dataDir,
          enabled: true,
          capabilities: agent.capabilities,
        });
      } else {
        // Mark as discovered-but-disabled so the UI can show "not installed"
        db.upsertAgent({
          id: t,
          name: collector.displayName,
          type: t,
          dataDir: '',
          enabled: false,
          capabilities: collector.defaultCapabilities,
        });
      }
    } catch (err) {
      console.warn(`[seed] failed to describe ${t}:`, err);
    }
  }
}