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
  | 'investigate-anomaly'  // v1.6: health anomaly (umbrella action)
  | 'investigate-anomaly-score-drop'         // v1.7: score-drop anomaly incident
  | 'investigate-anomaly-level-regression'   // v1.7: level-regression anomaly incident
  | 'investigate-anomaly-rapid-degradation'  // v1.7: rapid-degradation anomaly incident
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

/* ---------------- v1.4: Health Memory & Trend ---------------- */

/**
 * One recorded health sample. Persisted in the in-memory
 * HealthHistoryStore; never written to sessions / activity_events.
 *
 * Insertion is gated by `shouldRecordHealthSnapshot` — we only write
 * when the level changes OR a fixed time window has elapsed.
 */
export interface HealthSnapshotHistory {
  /** Optional row id (only set by the in-memory store). */
  id?: number;
  executionId: string;
  score: number;
  level: HealthLevel;
  /** Derived status at the time of recording (for cross-correlation). */
  derivedStatus: DerivedLifecycleStatus;
  factors: HealthFactor[];
  createdAt: string;
}

/**
 * Trend classification for a sequence of HealthSnapshotHistory rows.
 */
export type HealthTrendDirection = 'improving' | 'degrading' | 'stable';

/**
 * Pure projection: given N+1 snapshots, summarize the trajectory.
 * `scoreDelta` is the latest minus the oldest of the supplied window.
 * `samples` is the number of rows used.
 */
export interface HealthTrend {
  direction: HealthTrendDirection;
  /** Latest - oldest, in score points. Positive = improving. */
  scoreDelta: number;
  samples: number;
  /** One-line human-readable summary. */
  summary: string;
  /** ISO timestamp of the oldest sample in the analyzed window, or null. */
  from: string | null;
  /** ISO timestamp of the latest sample in the analyzed window. */
  to: string;
}

/**
 * Three-state lifecycle of an attention key (one entry per
 * (executionId, recommendedAction)). Tracking state lets us show
 * "this conflict appeared 2h ago and is still ongoing" rather than
 * "still in queue right now".
 */
export type AttentionLifecycleState = 'detected' | 'ongoing' | 'recovered';

/**
 * One row in the attention lifecycle log. Persisted in the
 * AttentionHistoryStore (in-memory).
 */
export interface AttentionHistoryEntry {
  id?: number;
  executionId: string;
  /** Stable key for the attention — currently the `recommendedAction` value. */
  attentionKey: string;
  lifecycle: AttentionLifecycleState;
  severity: AttentionSeverity;
  reason: string;
  createdAt: string;
}

/**
 * Per-agent reliability rollup. Computed on demand from a list of
 * HealthSnapshotHistory rows (or any other health samples).
 */
export interface AgentReliabilitySummary {
  agentType: string;
  /** Total samples used for the rollup. */
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  /** 0..100, weighted by recent samples if available. */
  reliabilityScore: number;
  /** failed / total (NaN-safe; 0 when total = 0). */
  failureRate: number;
  /** Average ms from `failed` -> `completed` transition; null if no transitions. */
  averageRecoveryTimeMs: number | null;
  /** When this rollup was computed. */
  computedAt: string;
}

/** Pick the worse of two confidence levels. */
export function worseConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank = { exact: 0, estimated: 1, unknown: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/* ---------------- v1.6: Health Anomaly ---------------- */

/**
 * Categories of health anomalies detected from the persisted
 * HealthSnapshotHistory sequence. Pure-function output of
 * `detectHealthAnomalies`. Severity is set per-row.
 *
 *   - score-drop        — adjacent snapshot's score fell by >= threshold
 *   - level-regression  — level moved toward 'critical' (healthy→warning→critical)
 *   - rapid-degradation — sliding window of N snapshots dropped by >= threshold
 */
export type HealthAnomalyKind = 'score-drop' | 'level-regression' | 'rapid-degradation';

/**
 * Severity rating of a single anomaly. Mirrors AttentionSeverity minus
 * 'low' / 'medium' since anomalies only fire when something is wrong.
 */
export type HealthAnomalySeverity = 'high' | 'critical';

/**
 * One detected anomaly. Pure-function derived; never persisted.
 *
 * `executionId` is denormalized so the UI can render anomalies inline
 * next to the execution that produced them.
 */
export interface HealthAnomaly {
  executionId: string;
  kind: HealthAnomalyKind;
  severity: HealthAnomalySeverity;
  /** Score at the start of the window that triggered the anomaly. */
  fromScore: number;
  /** Score at the end of the window that triggered the anomaly. */
  toScore: number;
  /** Level at the start; null if first snapshot. */
  fromLevel: HealthLevel | null;
  /** Level at the end. */
  toLevel: HealthLevel;
  /** ISO timestamp of the start of the window. */
  fromAt: string;
  /** ISO timestamp of the end of the window (when the anomaly fired). */
  detectedAt: string;
  /** Single-line human-readable explanation. */
  message: string;
}

/**
 * Window used by `detectHealthAnomalies`. All thresholds default to
 * conservative values that minimize false positives on small N.
 */
export interface HealthAnomalyOptions {
  /** Adjacent score drop that fires a 'score-drop' anomaly (default 30). */
  scoreDropThreshold?: number;
  /** Cumulative score drop across the rapid-degradation window (default 40). */
  rapidDegradationThreshold?: number;
  /** How many recent snapshots to consider for rapid-degradation (default 3). */
  rapidDegradationWindow?: number;
  /** Anomaly detection timestamp (test hook); defaults to Date.now(). */
  nowMs?: number;
}

/* ---------------- v1.7: Health Incident Intelligence ---------------- */

/**
 * One Health Incident — the lifecycle of a (execution, anomaly-kind)
 * pair tracked via the Attention history. Detected when an anomaly
 * first fires for an execution, ongoing while it keeps firing,
 * recovered when the anomaly stops appearing across reconciliation
 * passes.
 *
 * Pure-derived from `execution_attention_history` rows where
 * `attention_key = 'investigate-anomaly-*'` and `severity IN ('high','critical')`.
 *
 * v1.8: severity evolution — `initialSeverity`, `currentSeverity`,
 * `maxSeverity` track how severity changed across the incident's
 * lifetime. `escalationCount` is the number of severity upgrades
 * (high → critical). Severity never downgrades automatically.
 */
export interface HealthIncident {
  /** Stable incident key = `${executionId}|${anomalyKind}`. */
  incidentKey: string;
  executionId: string;
  /** Anomaly kind that triggered the incident (mirrors HealthAnomalyKind). */
  kind: HealthAnomalyKind;
  /** Worst severity observed across the incident's lifetime (= maxSeverity). */
  severity: HealthAnomalySeverity;
  /** Severity of the first 'detected' row. Same as maxSeverity for never-escalated incidents. */
  initialSeverity: HealthAnomalySeverity;
  /** Severity of the most recent transition row. May be 'low' if the latest row is a recovery row. */
  currentSeverity: HealthAnomalySeverity | 'low';
  /** Worst severity ever observed (alias for `severity`). */
  maxSeverity: HealthAnomalySeverity;
  /** Count of severity upgrades (high→critical). 0 if never escalated. */
  escalationCount: number;
  /** ISO timestamp of the first 'detected' row. */
  detectedAt: string;
  /** ISO timestamp of the latest transition (ongoing or recovered). null when still in 'detected'. */
  lastTransitionAt: string | null;
  /** Current state. */
  lifecycle: AttentionLifecycleState;
  /** ISO timestamp of the most recent 'recovered' row (only when recovered). */
  recoveredAt: string | null;
  /** ms from detectedAt → recoveredAt; null when not recovered or recovered in same pass. */
  durationMs: number | null;
  /** Reason text (from the anomaly that triggered detection). */
  reason: string;
}

/**
 * Detailed transition record — one per attention row that wrote
 * a 'detected' / 'ongoing' / 'recovered' state change.
 *
 * Used in HealthIncidentDetail.transitions for the per-incident
 * timeline view.
 */
export interface IncidentTransition {
  /** ISO timestamp of this transition row. */
  at: string;
  /** Lifecycle state written at this point. */
  lifecycle: AttentionLifecycleState;
  /** Severity written at this point (note: recovery rows always use 'low'). */
  severity: HealthAnomalySeverity | 'low';
  /** Reason text from the attention row (for detected/ongoing: [kind] message; for recovered: 'No longer in attention queue'). */
  reason: string;
}

/**
 * Severity upgrade record — emitted when severity escalates from
 * 'high' to 'critical' (the only allowed upgrade direction).
 */
export interface IncidentSeverityChange {
  /** ISO timestamp of the row that introduced the new (higher) severity. */
  at: string;
  /** Previous severity (always 'high' in v1.8 — only one upgrade direction). */
  from: HealthAnomalySeverity;
  /** New severity (always 'critical'). */
  to: HealthAnomalySeverity;
  /** Why did severity change. For now always 'anomaly-fired-with-critical-severity'. */
  reason: string;
}

/**
 * Per-incident detail returned by `GET /api/incidents/:incidentKey`.
 * Same fields as HealthIncident plus a chronological timeline.
 */
export interface HealthIncidentDetail extends HealthIncident {
  /** Every lifecycle row that produced this incident (oldest → newest). */
  transitions: IncidentTransition[];
  /** Every severity upgrade that happened (empty for never-escalated incidents). */
  severityHistory: IncidentSeverityChange[];
  /** When this detail was computed. */
  computedAt: string;
}

/**
 * Workspace-level incident rollup. Pure aggregation, no DB writes.
 * Returned by `/api/incidents/summary`.
 */
export interface IncidentSummary {
  /** Incidents in 'detected' or 'ongoing' state. */
  active: number;
  /** Incidents that have transitioned to 'recovered'. */
  recovered: number;
  /** Active + recovered critical-severity incidents. */
  criticalCount: number;
  /** Active + recovered high-severity incidents. */
  highCount: number;
  /** Top N most-active executions (by active incident count), descending. */
  topAffected: Array<{
    executionId: string;
    activeCount: number;
    worstSeverity: HealthAnomalySeverity;
  }>;
  /** Most recent N recovered incidents, newest first. */
  recentRecovered: HealthIncident[];
  /** When this summary was computed. */
  computedAt: string;
}

/* ---------------- v1.9: Incident Correlation & Intelligence ---------------- */

/**
 * Per-execution incident aggregation. One row per executionId that
 * has ≥1 anomaly-derived incident.
 *
 * Pure-derived from `HealthIncident[]`. No DB writes.
 */
export interface ExecutionIncidentInsight {
  executionId: string;
  /** All incident kinds affecting this execution. */
  kinds: HealthAnomalyKind[];
  /** All unique incidents for this execution (deduped by incidentKey). */
  incidents: number;
  /** Active incidents (lifecycle !== 'recovered'). */
  active: number;
  /** Recovered incidents. */
  recovered: number;
  /** Worst severity observed (critical > high). */
  worstSeverity: HealthAnomalySeverity;
  /** Sum of escalationCount across all incidents in this execution. */
  totalEscalations: number;
  /** Most recent transition timestamp (any incident). */
  lastTransitionAt: string | null;
}

/**
 * Per-agent incident aggregation. Cross-execution view: one row per
 * AgentType with rolled-up counts across all executions owned by that
 * agent.
 *
 * Pure-derived from `HealthIncident[]` + an executionId → agentType
 * map (caller supplies it; we never infer agent type from
 * executionId directly).
 */
export interface AgentIncidentInsight {
  agentType: string;
  /** All execution IDs owned by this agent that have ≥1 incident. */
  affectedExecutions: number;
  /** Total incidents for this agent. */
  incidentCount: number;
  /** Active incidents (lifecycle !== 'recovered'). */
  active: number;
  /** Recovered incidents. */
  recovered: number;
  /** Critical-severity incidents (active + recovered). */
  criticalCount: number;
  /** High-severity incidents (active + recovered). */
  highCount: number;
  /** Total severity escalations across all executions of this agent. */
  totalEscalations: number;
  /** Worst severity observed. */
  worstSeverity: HealthAnomalySeverity;
  /** ISO timestamp of the most recent transition for this agent. */
  lastTransitionAt: string | null;
}

/**
 * Per-kind incident aggregation. Cross-execution + cross-agent view.
 */
export interface KindIncidentInsight {
  kind: HealthAnomalyKind;
  incidentCount: number;
  active: number;
  recovered: number;
  criticalCount: number;
  highCount: number;
  /** Unique (executionId) pairs that have this kind. */
  affectedExecutions: number;
  /** Sum of escalationCount for this kind. */
  totalEscalations: number;
  lastTransitionAt: string | null;
}

/**
 * Cross-cutting correlation between multiple incidents. Used by
 * `/api/incidents/correlations` to surface patterns like
 * "5 score-drop incidents across claude-code in the last hour" or
 * "2 simultaneous level-regression on the same agent".
 *
 * The correlationKey is one of:
 *   - `agent:${AgentType}` — incidents grouped by agent
 *   - `kind:${HealthAnomalyKind}` — incidents grouped by kind
 *   - `agent-kind:${AgentType}:${HealthAnomalyKind}` — both axes
 */
export interface IncidentCorrelation {
  correlationKey: string;
  /** Free-form dimension label (e.g. 'agent', 'kind', 'agent-kind'). */
  dimension: 'agent' | 'kind' | 'agent-kind';
  /** Whether this correlation represents an active or historical pattern. */
  status: 'active' | 'mixed';
  affectedExecutions: number;
  affectedAgents: string[];
  incidentCount: number;
  activeCount: number;
  recoveredCount: number;
  /** Worst severity observed across the correlated incidents. */
  worstSeverity: HealthAnomalySeverity;
  /** The kind that appears most frequently (only meaningful for agent / agent-kind). */
  dominantKind: HealthAnomalyKind | null;
  /** Frequency signal: avg incidents per affected execution (≥1.0). */
  degradationFrequency: number;
  /** ISO timestamp of the most recent transition within this correlation. */
  lastTransitionAt: string | null;
  /** AgentType when dimension includes 'agent' or 'agent-kind'. */
  agentType?: string;
  /** Kind when dimension includes 'kind' or 'agent-kind'. */
  kind?: HealthAnomalyKind;
}

/**
 * Workspace-level correlation snapshot. Returned by
 * `/api/incidents/correlations`.
 */
export interface IncidentCorrelationSummary {
  correlations: IncidentCorrelation[];
  /** Total active incidents across all correlations. */
  totalActive: number;
  /** Total recovered incidents across all correlations. */
  totalRecovered: number;
  /** Number of distinct agents with ≥1 incident. */
  affectedAgentCount: number;
  /** Number of distinct executions with ≥1 incident. */
  affectedExecutionCount: number;
  /** Most-correlated agent (by total incidentCount, descending). */
  topAgent: string | null;
  /** Most-correlated kind (by total incidentCount, descending). */
  topKind: HealthAnomalyKind | null;
  computedAt: string;
}

/* ---------------- v1.10: Incident Temporal Intelligence ---------------- */

/**
 * Trend direction for a single agent's incident stream. Pure-derived
 * by comparing the [since, until] window against the immediately
 * preceding window of the same duration.
 *
 *   - 'improving'  : current window shows fewer incidents and/or
 *                     fewer active incidents than the previous window
 *   - 'degrading'  : current window shows more incidents and/or
 *                     more critical incidents than the previous window
 *   - 'stable'     : neither signal crosses the configurable threshold
 *                     (default 20%)
 *   - 'no-data'    : no incidents in either window (cannot decide)
 */
export type TrendDirection = 'improving' | 'stable' | 'degrading' | 'no-data';

/**
 * Per-agent reliability trend for a single time window. Includes a
 * comparison against the immediately preceding window so the UI can
 * answer "is this agent getting worse?".
 *
 * Pure-derived; deterministic; no DB writes.
 */
export interface AgentReliabilityTrend {
  agentType: string;
  /** ISO timestamp of the window start. */
  since: string;
  /** ISO timestamp of the window end (exclusive). */
  until: string;
  /** Window duration in ms (= until - since). */
  windowMs: number;
  /** Number of distinct executions owned by this agent in the window. */
  executionCount: number;
  /** Number of distinct executions that have ≥1 incident in the window. */
  affectedExecutions: number;
  /** Total incidents in the window. */
  incidentCount: number;
  /** Active incidents (lifecycle !== 'recovered') in the window. */
  activeCount: number;
  /** Recovered incidents (lifecycle === 'recovered') in the window. */
  recoveredCount: number;
  /** Critical-severity incidents in the window. */
  criticalCount: number;
  /** High-severity incidents in the window. */
  highCount: number;
  /** Total severity escalations across the window. */
  totalEscalations: number;
  /** Worst severity observed in the window. */
  worstSeverity: HealthAnomalySeverity;
  /**
   * Incidents per affected execution (≥1.0). Useful as a
   * "concentration" signal — values >1 mean an execution has
   * multiple incidents in the window.
   */
  degradationRate: number;
  /** Direction computed by comparing current vs previous window. */
  trendDirection: TrendDirection;
  /** Incident delta vs previous window (positive = more incidents now). */
  incidentDelta: number;
  /** Critical-incident delta vs previous window. */
  criticalDelta: number;
  /** Whether this agent appears in the workspace's top-N "degrading" list. */
  rankByIncidentCount: number | null;
}

/**
 * Workspace-level temporal snapshot over a time window.
 * Returned by `/api/incidents/temporal`.
 */
export interface IncidentTemporalSummary {
  /** ISO timestamp of the window start. */
  since: string;
  /** ISO timestamp of the window end (exclusive). */
  until: string;
  /** Window duration in ms. */
  windowMs: number;
  /** Total incidents whose detectedAt falls in [since, until). */
  incidentCount: number;
  /** Active incidents in the window (lifecycle !== 'recovered'). */
  activeCount: number;
  /** Recovered incidents in the window. */
  recoveredCount: number;
  /** Critical-severity incidents in the window. */
  criticalCount: number;
  /** High-severity incidents in the window. */
  highCount: number;
  /** Severity distribution: { critical, high } counts. */
  severityDistribution: {
    critical: number;
    high: number;
  };
  /** Distribution across anomaly kinds (incidentCount per kind). */
  byKind: Array<{
    kind: HealthAnomalyKind;
    incidentCount: number;
  }>;
  /** Distribution across agents (incidentCount per agent). */
  byAgent: Array<{
    agentType: string;
    incidentCount: number;
  }>;
  /** Incident density per hour (incidentCount / windowMs × 3_600_000). */
  densityPerHour: number;
  computedAt: string;
}

/**
 * Signal categories for intelligence insights. v1.10 supports:
 *   - 'burst'               — short-window spike of the same kind
 *   - 'agent-degradation'   — multiple executions of one agent in window
 *   - 'kind-surge'          — a kind frequency rising vs previous window
 *   - 'recovery-surge'      — many incidents resolving at once
 *
 * Signals are pure-derived observations; they are NOT incidents
 * and never modify incident lifecycle.
 */
export type IntelligenceSignalKind =
  | 'burst'
  | 'agent-degradation'
  | 'kind-surge'
  | 'recovery-surge';

/**
 * Severity of an intelligence signal. Used by the UI to color-code
 * the signal row (informational vs needs attention).
 */
export type IntelligenceSignalSeverity = 'info' | 'warn' | 'alert';

/**
 * One intelligence signal. Emitted by `detectIntelligenceSignals` for
 * a given incident set + time window.
 *
 * Signals are pure observations. They never trigger execution,
 * auto-mitigation, or lifecycle mutation.
 */
export interface IntelligenceSignal {
  /** Stable id: `${kind}:${subjectKey}`. */
  signalId: string;
  /** Signal category. */
  kind: IntelligenceSignalKind;
  /** UI severity tag. */
  severity: IntelligenceSignalSeverity;
  /** Subject key (agent type, kind, or composite). */
  subjectKey: string;
  /** Optional human-readable label (e.g. "claude-code:score-drop"). */
  subjectLabel?: string;
  /** ISO timestamp of the window start. */
  since: string;
  /** ISO timestamp of the window end. */
  until: string;
  /** Numeric score (interpretation depends on `kind`). */
  score: number;
  /** Threshold that triggered the signal (for explainability). */
  threshold: number;
  /** One-line human-readable description. */
  description: string;
}

/**
 * Workspace-level signal bundle returned alongside
 * IncidentTemporalSummary.
 */
export interface IntelligenceSignalSummary {
  signals: IntelligenceSignal[];
  /** Highest severity observed across signals. */
  highestSeverity: IntelligenceSignalSeverity | null;
  /** Total signal count. */
  totalCount: number;
  computedAt: string;
}

/* ---------------- v1.11: Incident Intelligence Prioritization ---------------- */

/**
 * Priority level — the discrete bucket into which a priority score
 * falls. Used by the UI to color-code the row (critical → red,
 * high → amber, medium → blue, low → muted).
 *
 * Mapping (deterministic, rule-based):
 *   - 'critical'  score >= 70
 *   - 'high'      score >= 50
 *   - 'medium'    score >= 30
 *   - 'low'       score <  30
 */
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Evidence type — the category of signal that contributed to the
 * priority score. Each type corresponds to one component of the
 * score formula; the `message` is the human-readable explanation.
 *
 *   - 'severity'    incident severity distribution
 *   - 'frequency'   burst / rapid incident count
 *   - 'impact'      affected executions / agents
 *   - 'trend'       direction (improving / stable / degrading / no-data)
 *   - 'base'        baseline (no specific input; placeholder for low scores)
 */
export type PriorityEvidenceKind = 'severity' | 'frequency' | 'impact' | 'trend' | 'base';

/**
 * One evidence item. Each priority insight exposes 0+ evidence items
 * that together explain the score. The chain is rendered in the UI
 * as a "why this matters" bullet list.
 */
export interface PriorityEvidence {
  kind: PriorityEvidenceKind;
  /** Component score contribution in [0, maxComponentScore]. */
  contribution: number;
  /** Maximum possible score for this component. */
  maxContribution: number;
  /** Human-readable explanation. */
  message: string;
}

/**
 * One prioritized intelligence insight. Pure-derived; deterministic;
 * no DB writes. Combines IntelligenceSignal + AgentReliabilityTrend +
 * IncidentTemporalSummary into a single ranked item.
 *
 * The score is the sum of component contributions (severity, frequency,
 * impact, trend). Level is derived from score via fixed thresholds.
 * `reasons` is the evidence chain explaining the score.
 */
export interface IncidentPriorityInsight {
  /** Stable id: `${signalKind}:${subjectKey}`. */
  priorityId: string;
  /** The signal kind that triggered this priority (one-to-one with IntelligenceSignal.kind). */
  signalKind: IntelligenceSignalKind;
  /** The signal severity tag. */
  signalSeverity: IntelligenceSignalSeverity;
  /** Subject identifier (kind or agentType, depending on signal). */
  subjectKey: string;
  /** Optional human-readable subject label. */
  subjectLabel?: string;
  /** The original signal this priority is built from (for traceability). */
  signalId: string;
  /** Original signal score (incident count, affected executions, etc). */
  signalScore: number;
  /** Original signal threshold. */
  signalThreshold: number;
  /** The original signal description (passthrough). */
  signalDescription: string;
  /** ISO timestamp of the window start. */
  since: string;
  /** ISO timestamp of the window end. */
  until: string;
  /**
   * Composite priority score in [0, 100]. Sum of:
   *   - severity   (max 40)
   *   - frequency  (max 10)
   *   - impact     (max 30)
   *   - trend      (max 20)
   *   - base       (max 0, never contributes; reserved for tie-breaking)
   * Total max = 100.
   */
  priorityScore: number;
  /** Priority level bucket derived from priorityScore. */
  priorityLevel: PriorityLevel;
  /** Evidence chain: ordered from highest to lowest contribution. */
  reasons: PriorityEvidence[];
  /**
   * Optional trend hint for the same subject. `null` when the
   * signal is not agent-keyed (e.g. burst-by-kind) or when the agent
   * trend query did not match.
   */
  trendHint: TrendDirection | null;
}

/**
 * Workspace-level priority summary returned by
 * `/api/incidents/priorities`. Top-N entries sorted by priorityScore
 * desc, then by signalSeverity desc, then by signalId asc.
 */
export interface IncidentPrioritySummary {
  /** Top-N prioritized insights. */
  priorities: IncidentPriorityInsight[];
  /** Highest priorityLevel across all priorities. */
  highestLevel: PriorityLevel | null;
  /** Count of priorities at each level. */
  byLevel: Record<PriorityLevel, number>;
  /** Total priority count (not capped by topN). */
  totalCount: number;
  /** ISO window start used for the calculation. */
  since: string;
  /** ISO window end used for the calculation. */
  until: string;
  computedAt: string;
}