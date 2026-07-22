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

/* ---------------- v0.6: Git projection ---------------- */

/**
 * Read-only view of one git commit. Computed on demand from
 * `git log` — never persisted. Sourced from the local repo that
 * owns `session.project` (walked up to find `.git/`).
 */
export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  body: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitRepoInfo {
  root: string;
  branch?: string;
  currentCommit?: string;
}

/** Returned by `GET /api/git/sessions/:id`. */
export interface GitSessionInfo {
  /** `null` if the session's project is not inside a git repository. */
  repo: GitRepoInfo | null;
  branch?: string;
  commits: GitCommitInfo[];
  /** Human-readable reason when `repo` is `null`. */
  reason?: string;
}

/* ---------------- v0.7: Session Management ---------------- */

/**
 * User-owned session metadata. The `sessions` table is read-only
 * from AgentOS's perspective (collectors own it), so all custom
 * user data lives in this separate table, keyed by `session_id`.
 */
export interface SessionMetadata {
  sessionId: string;
  displayName?: string | null;
  note?: string | null;
  /** JSON array of strings; stored as text in SQLite. */
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Partial update body for `PATCH /api/sessions/:id/metadata`. */
export interface SessionMetadataPatch {
  displayName?: string | null;
  note?: string | null;
  tags?: string[];
  pinned?: boolean;
}

/**
 * Returned by `GET /api/sessions/:id/resume`. Pure projection — the
 * command is generated, never executed.
 */
export interface ResumeCommand {
  agent: AgentType;
  command: string;
  /** The id the CLI actually accepts (usually `externalId`). */
  externalId: string;
  /** Free-form notes about how to use the command. */
  notes?: string;
}

/* ---------------- v0.8: Execution Intelligence ---------------- */

/**
 * Lifecycle status of a derived Execution. Three-state on purpose:
 *  - `running`   last activity within ACTIVE_THRESHOLD_S
 *  - `completed` end_time set OR has any associated git commit
 *  - `unknown`   end_time null, no commits, last activity older than threshold
 */
export type ExecutionStatus = 'running' | 'completed' | 'unknown';

/**
 * User-overridable status (v0.9). Decoupled from the auto-derived
 * ExecutionStatus so the user can express intent ("done", "blocked")
 * that the auto-rules can't infer. The frontend renders
 * `effectiveStatus = manualStatus ?? status`.
 */
export type ManualExecutionStatus =
  | 'todo'
  | 'in-progress'
  | 'done'
  | 'blocked'
  | 'archived';

/** What the UI actually shows: manual override wins, otherwise derived. */
export type EffectiveExecutionStatus = ExecutionStatus | ManualExecutionStatus;

/**
 * A derived "execution" — one logical task within a Session.
 *
 * An Execution is NOT stored anywhere. It is a pure projection over
 * `activity_events` ⨝ `usage_records` ⨝ `git_commits` for one Session,
 * grouped by a 30-minute gap rule (see execution-service.ts).
 *
 * Use cases the Session model alone can't answer:
 *  - "What did the agent actually do in this 2h slot?"
 *  - "Which edit produced commit X?"
 *  - "How much did this task cost?"
 *  - "Is this development cycle finished or still running?"
 */
export interface AgentExecution {
  /** Stable id derived from session + group index, e.g. `claude-code:abc:exec-2`. */
  id: string;
  sessionId: string;
  agentId: string;
  agentType: AgentType;
  /** Raw project path. */
  project: string;
  /** Display path (may differ from `project` if the agent URL-encodes it). */
  projectDisplay: string;
  /** Best-effort title (auto-derived from events / session). */
  title?: string | null;
  /** User-set display name (from execution_metadata); null when unset. */
  displayName?: string | null;
  /** Tags from execution_metadata; empty array when unset. */
  tags: string[];
  /** User-set manual status override; null when unset. */
  manualStatus?: ManualExecutionStatus | null;
  /**
   * What the UI should render. Computed as `manualStatus ?? status`
   * server-side. Manual wins because it expresses user intent.
   */
  effectiveStatus: EffectiveExecutionStatus;
  /** Inclusive start (earliest event in the group). */
  startTime: string;
  /** Exclusive end (latest event's timestamp + grace, or now if still running). */
  endTime?: string | null;
  durationMs: number;
  eventCount: number;
  tokenUsage: number;
  cost: number;
  /** Git commits whose timestamp falls in [startTime, endTime]. */
  commits: GitCommitInfo[];
  /** Auto-derived status (from activity + commits). */
  status: ExecutionStatus;
}

/**
 * Full Execution detail — adds the events and usage that fed the summary.
 * Returned by `GET /api/executions/:id`.
 */
export interface ExecutionDetail extends AgentExecution {
  /** Events that composed this execution, oldest first. */
  events: TimelineItem[];
  /** Usage records that fell in the execution window. */
  usage: UsageRecord[];
}

/* ---------------- v0.9: Execution Workspace ---------------- */

/**
 * Per-execution user customizations. Mirrors SessionMetadata's shape
 * (but no `pinned` — executions are already grouped into the Session's
 * pinned-first sort) and adds `manualStatus` for explicit status
 * overrides.
 *
 * Stored in the `execution_metadata` table; never mixed with
 * `execution` derivation tables.
 */
export interface ExecutionMetadata {
  executionId: string;
  displayName?: string | null;
  note?: string | null;
  /** JSON array of strings; stored as text in SQLite. */
  tags: string[];
  manualStatus?: ManualExecutionStatus | null;
  createdAt: string;
  updatedAt: string;
}

/** Partial update body for `PATCH /api/executions/:id/metadata`. */
export interface ExecutionMetadataPatch {
  displayName?: string | null;
  note?: string | null;
  tags?: string[];
  /** `null` clears the override. `'archived'` and others set it. */
  manualStatus?: ManualExecutionStatus | null;
}

/* ---------------- v1.0: Execution Board & Lifecycle ---------------- */

/**
 * Six-column Board categorization. The frontend maps:
 *   - manualStatus wins (its column = the manual status itself)
 *   - else derived maps: running -> running, unknown -> todo, completed -> done
 */
export type ExecutionBoardColumn =
  | 'todo'
  | 'in-progress'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';

/**
 * Where a status transition came from:
 *   - `manual`  user PATCHed execution_metadata
 *   - `auto`    the engine re-derived it from activity
 *
 * v1.0 only writes `manual` rows. The `auto` variant is reserved for
 * future background jobs that detect real status drift; we don't
 * auto-record to avoid filling history with no-op transitions.
 */
export type ExecutionStatusHistorySource = 'auto' | 'manual';

/**
 * Append-only log of every manual (and later, auto) change to an
 * execution's effective status. Used by the Lifecycle Timeline UI on
 * the ExecutionDetail page.
 */
export interface ExecutionStatusHistory {
  id: number;
  executionId: string;
  /** Previous status (`null` for the very first record). */
  fromStatus: EffectiveExecutionStatus | null;
  /** New status. */
  toStatus: EffectiveExecutionStatus;
  source: ExecutionStatusHistorySource;
  createdAt: string;
}

/**
 * One row in the Board. The frontend derives `boardColumn` from
 * `effectiveStatus` + `manualStatus`; we still model it explicitly so
 * the Kanban column bucketing logic is documented in the type.
 */
export interface ExecutionBoardItem {
  id: string;
  sessionId: string;
  agentId: string;
  agentType: AgentType;
  project: string;
  projectDisplay: string;
  displayName?: string | null;
  title?: string | null;
  tags: string[];
  manualStatus?: ManualExecutionStatus | null;
  effectiveStatus: EffectiveExecutionStatus;
  startTime: string;
  endTime?: string | null;
  durationMs: number;
  eventCount: number;
  tokenUsage: number;
  cost: number;
  commits: GitCommitInfo[];
  /** Which column this card lands in. */
  boardColumn: ExecutionBoardColumn;
}

/* ---------------- v1.1: Agent Lifecycle Intelligence Foundation ---------------- */

/**
 * Six-state lifecycle vocabulary. Decoupled from `ExecutionStatus`
 * (3-state: running / completed / unknown) so the analyzer can express
 * a richer picture without breaking the v0.8 contract. Every value
 * can be mapped to the older 3-state set:
 *   - queued / running        -> running
 *   - idle                     -> unknown
 *   - blocked                  -> unknown
 *   - completed                -> completed
 *   - failed                   -> unknown
 */
export type DerivedLifecycleStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'blocked'
  | 'completed'
  | 'failed';

/**
 * How confident the analyzer is in its derived status.
 *  - `high`   multiple strong indicators agree
 *  - `medium` one strong + one weak indicator, OR activity near a threshold
 *  - `low`    insufficient / contradictory evidence (e.g. zero events)
 */
export type LifecycleConfidence = 'high' | 'medium' | 'low';

/**
 * One piece of evidence the analyzer used to decide the status.
 * Examples:
 *  - { type: 'recent-activity', label: 'Last event 12s ago', weight: 1 }
 *  - { type: 'commit-landed',   label: '1 commit in window', weight: 0.8 }
 *  - { type: 'failure-marker',  label: 'session-failed event', weight: 1 }
 *
 * Weights are advisory — they're for the UI to render a
 * "why do you think this?" tooltip, not for math.
 */
export interface LifecycleIndicator {
  /** Stable enum-style code so the UI can match colors / icons. */
  type:
    | 'recent-activity'
    | 'no-activity'
    | 'commit-landed'
    | 'failure-marker'
    | 'session-ended'
    | 'empty-data'
    | 'contradiction'
    | 'idle-threshold-crossed'
    | 'blocked-threshold-crossed';
  /** Human-readable line. */
  label: string;
  /** 0..1 advisory weight. */
  weight: number;
}

/**
 * Read-only snapshot of an Execution's derived lifecycle.
 * Returned by `GET /api/executions/:id/lifecycle`. NOT stored —
 * computed on demand by `lifecycle-analyzer.ts`.
 */
export interface LifecycleSnapshot {
  executionId: string;
  derivedStatus: DerivedLifecycleStatus;
  confidence: LifecycleConfidence;
  /** One-line explanation suitable for a tooltip or "why?" line. */
  reason: string;
  /** ISO timestamp of the most recent evidence (event / commit). */
  lastActivityAt: string | null;
  /** Age in ms since `lastActivityAt`. `null` when no activity at all. */
  lastActivityAgeMs: number | null;
  /** Evidence trail — see LifecycleIndicator. */
  indicators: LifecycleIndicator[];
  /** When the snapshot was computed (server time). */
  computedAt: string;
}

/**
 * v1.2: manual vs derived mismatch detection.
 *
 * The user-set manualStatus is the source of truth (UI source of
 * authority), but it can drift out of sync with what the system
 * thinks the agent is doing (derivedStatus). When they disagree, we
 * surface a read-only LifecycleConflict for the UI to warn the user
 * — but we never auto-mutate the user's manual choice.
 */
export interface LifecycleConflict {
  executionId: string;
  /** The user's override, or null when no manual is set. */
  manualStatus: import('@agentos/shared').ManualExecutionStatus | null;
  derivedStatus: DerivedLifecycleStatus;
  confidence: LifecycleConfidence;
  reason: string;
  /** True iff manual and derived disagree on "completion-ish" buckets. */
  isConflict: boolean;
  /** Short label like "done vs running" for compact display. */
  label: string | null;
}

/**
 * v1.2: SSE event payload published when the cached lifecycle
 * snapshot for an execution changes (different derivedStatus from
 * the previous cached value). Slim on purpose — frontend refetches
 * the full snapshot via `/api/executions/:id/lifecycle`.
 */
export interface LifecycleChangedPayload {
  executionId: string;
  derivedStatus: DerivedLifecycleStatus;
  confidence: LifecycleConfidence;
  /** The previous derivedStatus in cache, or null on first emission. */
  previousDerivedStatus: DerivedLifecycleStatus | null;
  reason: string;
}

/* ---------------- v1.3: Agent Health Intelligence ---------------- */

/**
 * Three-bucket overall health. Score thresholds (configurable):
 *   - score >= 80  -> healthy
 *   - score >= 50  -> warning
 *   - score <  50  -> critical
 */
export type HealthLevel = 'healthy' | 'warning' | 'critical';

/**
 * One positive or negative contributor to the health score. `impact`
 * is signed (positive = healthier, negative = drag). Order in the
 * `factors[]` array is descending by absolute impact, so the UI can
 * render top contributors first.
 */
export interface HealthFactor {
  name: string;
  impact: number;
  reason: string;
}

/**
 * Read-only health assessment for a single execution.
 * Pure function over LifecycleSnapshot + LifecycleConflict.
 */
export interface LifecycleHealthScore {
  /** Integer 0..100. */
  score: number;
  level: HealthLevel;
  factors: HealthFactor[];
}

/**
 * Human-readable explanation of a lifecycle state. `bullets[]` is
 * ordered by importance. Always returns at least one bullet.
 */
export interface LifecycleExplanation {
  /** One-line summary suitable for a card header. */
  headline: string;
  /** Concise reasons, in priority order. */
  bullets: string[];
}

/**
 * Severity of an Attention Queue item. Sort order (asc): low < medium < high < critical.
 */
export type AttentionSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Suggested user action for an attention item. The action is a hint,
 * NOT auto-executed.
 */
export type AttentionAction =
  | 'review-conflict'      // manualStatus disagrees with derivedStatus
  | 'investigate-blocked'  // derived is blocked (recent commit + stale)
  | 'restart-or-abandon'   // derived is failed or stuck a long time
  | 'archive'              // very old, no movement
  | 'confirm-completion'   // manual=done but no end_time / commit
  | 'monitor'              // generic — keep an eye on it
  ;

/**
 * One item in the Attention Queue. Read-only — never auto-executes.
 */
export interface AttentionItem {
  executionId: string;
  severity: AttentionSeverity;
  reason: string;
  recommendedAction: AttentionAction;
  /** Snapshot derivedStatus (so UI can show icon without re-fetching). */
  derivedStatus: DerivedLifecycleStatus | null;
  /** When the underlying situation was first observed (ISO). null if unknown. */
  detectedAt: string | null;
  /** Health score if computed (omitted when inputs missing). */
  healthScore?: number;
  /** Health level if computed. */
  healthLevel?: HealthLevel;
}

/**
 * Workspace-level summary aggregated across every visible execution.
 */
export interface WorkspaceHealthSummary {
  healthy: number;
  warning: number;
  critical: number;
  /** Manual-vs-derived conflicts across all visible executions. */
  conflictCount: number;
  /** The execution with the longest active duration (running/idle), or null. */
  longestRunning: {
    executionId: string;
    startedAt: string;
    durationMs: number;
    derivedStatus: DerivedLifecycleStatus;
  } | null;
  /** Total executions summarized. */
  total: number;
  /** When this summary was computed. */
  computedAt: string;
}

/** Pick the worse of two confidence levels. */
export function worseConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank = { exact: 0, estimated: 1, unknown: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}