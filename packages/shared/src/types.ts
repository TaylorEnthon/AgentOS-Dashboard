/**
 * Unified Agent data model — shared across collectors, backend, and frontend.
 * All collectors MUST normalize into these shapes; the backend persists them
 * verbatim and the frontend renders them.
 *
 * v0.2 additions (additive, backward compatible):
 *  - SourceMeta on every persisted record → full data provenance.
 *  - ConfidenceLevel on usage / cost → users can tell exact vs estimated.
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

/**
 * Confidence in a token / cost number.
 *  - `exact`:    read directly from the agent's structured usage field
 *  - `estimated`: derived from partial data (e.g. missing cache split,
 *                 token count inferred from char count)
 *  - `unknown`:  no reliable source (e.g. model unrecognized, tokens zero)
 */
export type ConfidenceLevel = 'exact' | 'estimated' | 'unknown';

/**
 * Where a record came from. Attached to every persisted row so the UI
 * (and future trust reports) can trace any number back to its source file.
 */
export interface SourceMeta {
  /** Absolute path of the source file (e.g. ~/.claude/projects/x/s.jsonl). */
  sourceFile: string;
  /** Provider = agent type. Always set; intentionally narrower than a freeform string. */
  sourceProvider: AgentType;
  /**
   * Stable per-record id used for dedup. Sessions: `${provider}:${externalId}`.
   * Usage / events: `${provider}:${externalId}:${lineKey}`.
   * MUST match the persisted `id` (or its primary key prefix) for INSERT OR IGNORE.
   */
  sourceId: string;
  /** ISO timestamp of when this record was collected (batch time, not per-event). */
  collectedAt: string;
}

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
  /** Aggregate confidence across the session's usage records. */
  usageConfidence?: ConfidenceLevel;
  /** Aggregate confidence across the session's cost calculations. */
  costConfidence?: ConfidenceLevel;
  /** Provenance — set by collectors, persisted verbatim. */
  source?: SourceMeta;
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
  /** Per-record confidence in the token counts. */
  usageConfidence: ConfidenceLevel;
  /** Per-record confidence in the cost number (model resolution + cache pricing). */
  costConfidence: ConfidenceLevel;
  /** True iff the model string didn't resolve to any pricing entry. */
  unknownModel: boolean;
  source?: SourceMeta;
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
  source?: SourceMeta;
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
  collectedAt: string;
  sessions: AgentSession[];
  usage: UsageRecord[];
  events: ActivityEvent[];
  projects: Array<{ path: string; displayName: string; lastSeen: string }>;
  /**
   * Per-file provenance + fingerprint, so the ingest layer can update
   * `ingestion_files` for future incremental scans.
   */
  files: Array<FileFingerprint>;
}

export interface FileFingerprint {
  sourceFile: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the file contents (or first chunk for very large files). */
  contentHash: string;
  sessions: number;
  usageRecords: number;
  events: number;
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

/**
 * Trust & provenance summary returned by `/api/data-health`.
 */
export interface DataHealth {
  totalSessions: number;
  totalUsageRecords: number;
  totalEvents: number;
  /** usage confidence breakdown across all persisted usage rows. */
  usage: { exact: number; estimated: number; unknown: number };
  /** cost confidence breakdown across all persisted usage rows. */
  cost: { exact: number; estimated: number; unknown: number };
  /** usage rows that were ignored on the most recent scan because the id already existed. */
  duplicatesPrevented: number;
  /** agents whose last_scanned_at is most recent. */
  lastScanAt?: string;
  ingestionFiles: number;
  ingestionFileSize: number;
  /** Per-agent last-scan summary. */
  perAgent: Array<{
    agentId: string;
    lastScanAt?: string;
    files: number;
    sessions: number;
    usage: number;
    duplicates: number;
  }>;
}

/**
 * Pure projection over `activity_events ⨝ sessions`. Used by
 * `/api/timeline` and the Timeline page. Never written — always derived.
 */
export interface TimelineItem {
  id: string;
  agentId: string;
  agentType: AgentType;
  sessionId: string;
  sessionTitle?: string | null;
  project: string;
  projectDisplay: string;
  timestamp: string;
  type: ActivityEventType;
  /** Human-readable summary; derived from `type` + `detail`. */
  action: string;
  detail?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Pick the worse of two confidence levels. */
export function worseConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank = { exact: 0, estimated: 1, unknown: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}