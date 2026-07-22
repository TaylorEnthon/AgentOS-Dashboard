/**
 * Unified Agent data model — shared across collectors, backend, and frontend.
 * All collectors MUST normalize into these shapes; the backend persists them
 * verbatim and the frontend renders them.
 */

export type AgentType =
  | 'claude-code'
  | 'codex'
  | 'grok'
  | 'gemini'
  | 'hermes'
  | 'custom';

export const ALL_AGENT_TYPES: AgentType[] = [
  'claude-code',
  'codex',
  'grok',
  'gemini',
  'hermes',
  'custom',
];

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  dataDir: string;
  enabled: boolean;
  capabilities?: string[];
  lastScannedAt?: string;
}

export type SessionStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface AgentSession {
  /** composite id: `${agentId}:${externalId}` */
  id: string;
  agentId: string;
  agentType: AgentType;
  externalId: string;
  /** raw project path (may be URL-encoded by the agent) */
  project: string;
  /** human-readable project path */
  projectDisplay: string;
  title?: string;
  startTime: string;
  endTime?: string;
  status: SessionStatus;
  model?: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fileOps: number;
  toolCalls: number;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: string;
}

export type ActivityEventType =
  | 'session-start'
  | 'session-end'
  | 'message'
  | 'tool-call'
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'command'
  | 'git-commit'
  | 'status';

export interface ActivityEvent {
  id: string;
  sessionId: string;
  agentId: string;
  type: ActivityEventType;
  timestamp: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface Project {
  path: string;
  displayName: string;
  agents: AgentType[];
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  lastActivity?: string;
}

/**
 * Raw output of a collector scan before persistence.
 * The ingest layer is responsible for upserting into SQLite.
 */
export interface RawScanResult {
  agentId: string;
  sessions: AgentSession[];
  usage: UsageRecord[];
  events: ActivityEvent[];
  projects: Array<{ path: string; displayName: string; lastSeen: string }>;
}

export interface OverviewStats {
  totalAgents: number;
  enabledAgents: number;
  totalSessions: number;
  activeSessions: number;
  todayTokens: number;
  todayCost: number;
  todaySessions: number;
  totalTokens: number;
  totalCost: number;
  byAgent: Array<{
    agentId: string;
    agentType: AgentType;
    name: string;
    sessions: number;
    tokens: number;
    cost: number;
  }>;
  recentSessions: AgentSession[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    sessions: number;
  }>;
}