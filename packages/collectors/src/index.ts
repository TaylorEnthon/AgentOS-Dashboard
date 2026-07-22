import { BaseCollector } from './base.js';
import { ClaudeCollector } from './claude.js';
import { CodexCollector } from './codex.js';
import { GrokCollector } from './grok.js';
import { GeminiCollector, HermesCollector } from './stubs.js';
import type { AgentType } from '@agentos/shared';

export { BaseCollector, ClaudeCollector, CodexCollector, GrokCollector, GeminiCollector, HermesCollector };
export * from './base.js';

/**
 * Registry of every collector the backend knows how to run.
 * Adding a new agent = one new class + one entry here.
 */
export const COLLECTORS: Record<AgentType, () => BaseCollector> = {
  'claude-code': () => new ClaudeCollector(),
  codex: () => new CodexCollector(),
  grok: () => new GrokCollector(),
  gemini: () => new GeminiCollector(),
  hermes: () => new HermesCollector(),
  custom: () => {
    throw new Error('Custom agents must be supplied via settings; no default collector.');
  },
};

export function buildCollector(type: AgentType): BaseCollector {
  const factory = COLLECTORS[type];
  if (!factory) throw new Error(`Unknown agent type: ${type}`);
  return factory();
}