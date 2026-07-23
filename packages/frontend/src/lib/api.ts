/**
 * Tiny typed API client. The backend serves `/api/*` on the same origin
 * (or proxied via vite in dev), so we use relative URLs.
 */
import type { AgentType } from '@agentos/shared';

export type Confidence = 'exact' | 'estimated' | 'unknown';

export interface AgentDto {
  id: string;
  name: string;
  type: AgentType;
  dataDir: string;
  enabled: boolean;
  capabilities: string[];
  lastScannedAt?: string | null;
  sessions: number;
  tokens: number;
  cost: number;
}

export interface SourceMetaDto {
  sourceFile: string;
  sourceProvider: AgentType;
  sourceId: string;
  collectedAt: string;
}

export interface SessionDto {
  id: string;
  agentId: string;
  agentType: AgentType;
  externalId: string;
  project: string;
  projectDisplay: string;
  title?: string | null;
  startTime: string;
  endTime?: string | null;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  model?: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fileOps: number;
  toolCalls: number;
  usageConfidence?: Confidence;
  costConfidence?: Confidence;
  source?: SourceMetaDto;
}

export interface ProjectDto {
  path: string;
  displayName: string;
  agents: AgentType[];
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  lastActivity?: string;
}

export interface OverviewDto {
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
  recentSessions: SessionDto[];
  daily: Array<{ date: string; tokens: number; cost: number; sessions: number }>;
}

export interface SettingsDto {
  dataDirOverrides: Record<string, string>;
  enabledAgents: Record<string, boolean>;
  pollIntervalSec: number;
  pricingOverrides: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  defaultPricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export interface SessionDetailDto extends SessionDto {
  usage: Array<{
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
    usageConfidence: Confidence;
    costConfidence: Confidence;
    unknownModel: boolean;
    source?: SourceMetaDto;
  }>;
  events: Array<{
    id: string;
    sessionId: string;
    agentId: string;
    type: string;
    timestamp: string;
    detail?: string | null;
    meta?: Record<string, unknown>;
    source?: SourceMetaDto;
  }>;
}

export interface DataHealthDto {
  totalSessions: number;
  totalUsageRecords: number;
  totalEvents: number;
  usage: { exact: number; estimated: number; unknown: number };
  cost: { exact: number; estimated: number; unknown: number };
  duplicatesPrevented: number;
  lastScanAt?: string;
  ingestionFiles: number;
  ingestionFileSize: number;
  perAgent: Array<{
    agentId: string;
    lastScanAt?: string;
    files: number;
    sessions: number;
    usage: number;
    duplicates: number;
  }>;
}

export interface IngestionFileDto {
  id: string;
  provider: AgentType;
  file_path: string;
  size: number;
  mtime_ms: number;
  content_hash: string;
  last_scanned_at: string;
  sessions: number;
  usage_records: number;
  events: number;
  duplicates_prevented: number;
}

export type AgentStatus = 'active' | 'idle' | 'unknown';

export interface AgentStatusDto {
  agent: string;
  status: AgentStatus;
  lastActivity?: string;
  lastProject?: string;
  lastAction?: string;
  lastEventType?: string;
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

export interface TimelineItemDto {
  id: string;
  agentId: string;
  agentType: AgentType;
  sessionId: string;
  sessionTitle?: string | null;
  project: string;
  projectDisplay: string;
  timestamp: string;
  type: ActivityEventType;
  action: string;
  detail?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface GitCommitDto {
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

export interface GitRepoDto {
  root: string;
  branch?: string;
  currentCommit?: string;
}

export interface GitSessionInfoDto {
  repo: GitRepoDto | null;
  branch?: string;
  commits: GitCommitDto[];
  reason?: string;
}

/* ---------------- v0.7: Session Management ---------------- */

export interface SessionListItemDto extends SessionDto {
  displayName?: string | null;
  note?: string | null;
  tags: string[];
  pinned: boolean;
  metadataCreatedAt?: string;
  metadataUpdatedAt?: string;
  eventCount: number;
  usageTokens: number;
  usageCost: number;
}

export interface SessionV2DetailDto extends SessionListItemDto {
  /** Full metadata row from `session_metadata` (displayName/note/tags/pinned + timestamps). */
  metadata: {
    sessionId: string;
    displayName?: string | null;
    note?: string | null;
    tags: string[];
    pinned: boolean;
    createdAt?: string;
    updatedAt: string;
  } | null;
  /** Computed duration: end - start (or now - start if still running). */
  durationMs: number | null;
  git: GitSessionInfoDto | null;
  usage: SessionDetailDto['usage'];
  events: SessionDetailDto['events'];
}

export interface SessionResumeDto {
  agent: AgentType;
  command: string;
  externalId: string;
  notes?: string;
}

/* ---------------- v0.8: Execution Intelligence ---------------- */

export type ExecutionStatus = 'running' | 'completed' | 'unknown';

export type ManualExecutionStatus = 'todo' | 'in-progress' | 'done' | 'blocked' | 'archived';

export type EffectiveExecutionStatus = ExecutionStatus | ManualExecutionStatus;

export interface AgentExecutionDto {
  id: string;
  sessionId: string;
  agentId: string;
  agentType: AgentType;
  project: string;
  projectDisplay: string;
  title?: string | null;
  /** v0.9: user-set display name (from execution_metadata). null when unset. */
  displayName?: string | null;
  /** v0.9: note (from execution_metadata). null when unset. */
  note?: string | null;
  /** v0.9: tags from execution_metadata. */
  tags: string[];
  /** v0.9: user manual status override. null when unset. */
  manualStatus?: ManualExecutionStatus | null;
  /** v0.9: what the UI should render — manualStatus ?? status. */
  effectiveStatus: EffectiveExecutionStatus;
  startTime: string;
  endTime?: string | null;
  durationMs: number;
  eventCount: number;
  tokenUsage: number;
  cost: number;
  commits: GitCommitDto[];
  status: ExecutionStatus;
}

export interface ExecutionDetailDto extends AgentExecutionDto {
  events: TimelineItemDto[];
  usage: Array<{
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
    usageConfidence: Confidence;
    costConfidence: Confidence;
    unknownModel: boolean;
    source?: SourceMetaDto;
  }>;
}

/** v0.9: per-execution user customizations. */
export interface ExecutionMetadataDto {
  executionId: string;
  displayName?: string | null;
  note?: string | null;
  tags: string[];
  manualStatus?: ManualExecutionStatus | null;
  createdAt?: string;
  updatedAt: string;
}

/** v0.9: patch body for `PATCH /api/executions/:id/metadata`. */
export interface ExecutionMetadataPatch {
  displayName?: string | null;
  note?: string | null;
  tags?: string[];
  manualStatus?: ManualExecutionStatus | null;
}

/* ---------------- v1.0: Execution Board & Lifecycle ---------------- */

export type ExecutionBoardColumn =
  | 'todo'
  | 'in-progress'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';

export type ExecutionStatusHistorySource = 'auto' | 'manual';

/** One transition in an Execution's lifecycle. */
export interface ExecutionStatusHistoryDto {
  id: number;
  executionId: string;
  fromStatus: EffectiveExecutionStatus | null;
  toStatus: EffectiveExecutionStatus;
  source: ExecutionStatusHistorySource;
  createdAt: string;
}

/* ---------------- v1.1: Agent Lifecycle Intelligence ---------------- */

export type DerivedLifecycleStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'blocked'
  | 'completed'
  | 'failed';

export type LifecycleConfidence = 'high' | 'medium' | 'low';

export interface LifecycleIndicatorDto {
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
  label: string;
  weight: number;
}

export interface LifecycleSnapshotDto {
  executionId: string;
  derivedStatus: DerivedLifecycleStatus;
  confidence: LifecycleConfidence;
  reason: string;
  lastActivityAt: string | null;
  lastActivityAgeMs: number | null;
  indicators: LifecycleIndicatorDto[];
  computedAt: string;
}

/** v1.2: manual vs derived conflict. Read-only. */
export interface LifecycleConflictDto {
  executionId: string;
  manualStatus: 'todo' | 'in-progress' | 'done' | 'blocked' | 'archived' | null;
  derivedStatus: DerivedLifecycleStatus;
  confidence: LifecycleConfidence;
  reason: string;
  isConflict: boolean;
  label: string | null;
}

/* ---------------- v1.3: Agent Health Intelligence ---------------- */

export type HealthLevel = 'healthy' | 'warning' | 'critical';

export interface HealthFactorDto {
  name: string;
  impact: number;
  reason: string;
}

export interface LifecycleHealthScoreDto {
  score: number;
  level: HealthLevel;
  factors: HealthFactorDto[];
}

export interface LifecycleExplanationDto {
  headline: string;
  bullets: string[];
}

export type AttentionSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AttentionAction =
  | 'review-conflict'
  | 'investigate-blocked'
  | 'restart-or-abandon'
  | 'archive'
  | 'confirm-completion'
  | 'monitor'
  | 'investigate-anomaly';

export interface AttentionItemDto {
  executionId: string;
  severity: AttentionSeverity;
  reason: string;
  recommendedAction: AttentionAction;
  derivedStatus: DerivedLifecycleStatus | null;
  detectedAt: string | null;
  healthScore?: number;
  healthLevel?: HealthLevel;
}

export interface WorkspaceHealthSummaryDto {
  healthy: number;
  warning: number;
  critical: number;
  conflictCount: number;
  longestRunning: {
    executionId: string;
    startedAt: string;
    durationMs: number;
    derivedStatus: DerivedLifecycleStatus;
  } | null;
  total: number;
  computedAt: string;
}

/* ---------------- v1.4: Health Memory & Trend ---------------- */

export interface HealthSnapshotHistoryDto {
  id?: number;
  executionId: string;
  score: number;
  level: HealthLevel;
  derivedStatus: DerivedLifecycleStatus;
  factors: HealthFactorDto[];
  createdAt: string;
}

export type HealthTrendDirection = 'improving' | 'degrading' | 'stable';

export interface HealthTrendDto {
  direction: HealthTrendDirection;
  scoreDelta: number;
  samples: number;
  summary: string;
  from: string | null;
  to: string;
}

export type AttentionLifecycleState = 'detected' | 'ongoing' | 'recovered';

export interface AttentionHistoryEntryDto {
  id?: number;
  executionId: string;
  attentionKey: string;
  lifecycle: AttentionLifecycleState;
  severity: AttentionSeverity;
  reason: string;
  createdAt: string;
}

export interface HealthAnomalyDto {
  executionId: string;
  kind: 'score-drop' | 'level-regression' | 'rapid-degradation';
  severity: 'high' | 'critical';
  fromScore: number;
  toScore: number;
  fromLevel: HealthLevel | null;
  toLevel: HealthLevel;
  fromAt: string;
  detectedAt: string;
  message: string;
}

export interface AgentReliabilitySummaryDto {
  agentType: string;
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  reliabilityScore: number;
  failureRate: number;
  averageRecoveryTimeMs: number | null;
  computedAt: string;
}

export interface SessionMetadataPatch {
  displayName?: string | null;
  note?: string | null;
  tags?: string[];
  pinned?: boolean;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  overview: () => http<OverviewDto>('/api/overview'),
  agents: () => http<AgentDto[]>('/api/agents'),
  agent: (id: string) => http<AgentDto & { sessions: SessionDto[] }>(`/api/agents/${encodeURIComponent(id)}`),
  setAgentEnabled: (id: string, enabled: boolean) =>
    http<AgentDto>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  sessions: (params: { agent?: string; project?: string; limit?: number; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
    return http<SessionDto[]>(`/api/sessions?${q.toString()}`);
  },
  session: (id: string) => http<SessionDetailDto>(`/api/sessions/${encodeURIComponent(id)}`),
  projects: () => http<ProjectDto[]>('/api/projects'),
  refresh: (forceFull = false) =>
    http<{ ok: boolean; ts: string; mode: string; reports: Array<{ agentId: string; sessions: number; usage: number; events: number; filesScanned: number; duplicatesPrevented: number; ms: number; error?: string }> }>(
      '/api/refresh',
      { method: 'POST', body: JSON.stringify({ forceFull }) },
    ),
  settings: () => http<SettingsDto>('/api/settings'),
  saveSettings: (s: Partial<SettingsDto>) => http<SettingsDto>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),

  // v0.2
  dataHealth: () => http<DataHealthDto>('/api/data-health'),
  ingestionFiles: (provider?: AgentType) =>
    http<IngestionFileDto[]>(`/api/ingestion-files${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),

  // v0.4
  agentStatus: () => http<AgentStatusDto[]>('/api/agents/status'),

  // v0.5
  timeline: (params: { agent?: string; project?: string; session?: string; from?: string; to?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && q.set(k, String(v)));
    return http<TimelineItemDto[]>(`/api/timeline${q.toString() ? `?${q.toString()}` : ''}`);
  },

  // v0.6
  gitSessionCommits: (id: string) => http<GitSessionInfoDto>(`/api/git/sessions/${encodeURIComponent(id)}`),

  // v0.7: Session Management
  sessionsV2: (params: { agent?: string; project?: string; search?: string; status?: string; pinned?: string | boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === '') return;
      q.set(k, String(v));
    });
    const qs = q.toString();
    return http<SessionListItemDto[]>(`/api/sessions-v2${qs ? `?${qs}` : ''}`);
  },
  sessionV2: (id: string) => http<SessionV2DetailDto>(`/api/sessions-v2/${encodeURIComponent(id)}`),
  patchSessionMetadata: (id: string, patch: SessionMetadataPatch) =>
    http<{
      sessionId: string;
      displayName?: string | null;
      note?: string | null;
      tags: string[];
      pinned: boolean;
      createdAt?: string;
      updatedAt: string;
    }>(`/api/sessions-v2/${encodeURIComponent(id)}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  sessionResume: (id: string) =>
    http<SessionResumeDto>(`/api/sessions-v2/${encodeURIComponent(id)}/resume`),

  // v0.8: Execution Intelligence
  executions: (params: {
    agent?: string;
    session?: string;
    project?: string;
    tag?: string;
    status?: string;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === '') return;
      q.set(k, String(v));
    });
    const qs = q.toString();
    return http<AgentExecutionDto[]>(`/api/executions${qs ? `?${qs}` : ''}`);
  },
  execution: (id: string) =>
    http<ExecutionDetailDto>(`/api/executions/${encodeURIComponent(id)}`),
  sessionExecutions: (sessionId: string) =>
    http<AgentExecutionDto[]>(`/api/sessions-v2/${encodeURIComponent(sessionId)}/executions`),

  // v0.9: Execution Workspace
  executionMetadata: (id: string) =>
    http<{ metadata: ExecutionMetadataDto | null; effectiveStatus: EffectiveExecutionStatus | null }>(
      `/api/executions/${encodeURIComponent(id)}/metadata`,
    ),
  patchExecutionMetadata: (id: string, patch: ExecutionMetadataPatch) =>
    http<ExecutionMetadataDto>(`/api/executions/${encodeURIComponent(id)}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // v1.0: Execution Board & Lifecycle
  executionHistory: (id: string) =>
    http<ExecutionStatusHistoryDto[]>(`/api/executions/${encodeURIComponent(id)}/history`),

  // v1.1: Agent Lifecycle Intelligence
  executionLifecycle: (id: string) =>
    http<LifecycleSnapshotDto>(`/api/executions/${encodeURIComponent(id)}/lifecycle`),
  lifecycleBatch: (ids: string[]) =>
    http<Record<string, LifecycleSnapshotDto>>('/api/lifecycle/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  // v1.2: Conflict detection
  executionConflict: (id: string) =>
    http<LifecycleConflictDto>(`/api/executions/${encodeURIComponent(id)}/conflict`),
  conflictBatch: (ids: string[]) =>
    http<Record<string, LifecycleConflictDto>>('/api/conflicts/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  // v1.3: Agent Health Intelligence
  executionHealth: (id: string) =>
    http<{ score: LifecycleHealthScoreDto; explanation: LifecycleExplanationDto }>(
      `/api/executions/${encodeURIComponent(id)}/health`,
    ),
  healthBatch: (ids: string[]) =>
    http<Record<string, LifecycleHealthScoreDto>>('/api/health/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  attentionQueue: (limit?: number) =>
    http<AttentionItemDto[]>(`/api/attention${limit != null ? `?limit=${limit}` : ''}`),
  workspaceSummary: () =>
    http<WorkspaceHealthSummaryDto>('/api/workspace/summary'),
  // v1.4: Health Memory & Trend
  executionHealthHistory: (
    id: string,
    opts?: number | { limit?: number; from?: string; to?: string },
  ) => {
    const params = new URLSearchParams();
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    if (o?.limit != null) params.set('limit', String(o.limit));
    if (o?.from) params.set('from', o.from);
    if (o?.to)   params.set('to', o.to);
    const qs = params.toString();
    return http<HealthSnapshotHistoryDto[]>(
      `/api/executions/${encodeURIComponent(id)}/health/history${qs ? `?${qs}` : ''}`,
    );
  },
  executionHealthTrend: (
    id: string,
    opts?: number | { limit?: number; from?: string; to?: string },
  ) => {
    const params = new URLSearchParams();
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    if (o?.limit != null) params.set('limit', String(o.limit));
    if (o?.from) params.set('from', o.from);
    if (o?.to)   params.set('to', o.to);
    const qs = params.toString();
    return http<HealthTrendDto>(
      `/api/executions/${encodeURIComponent(id)}/health/trend${qs ? `?${qs}` : ''}`,
    );
  },
  executionAttentionHistory: (
    id: string,
    opts?: number | { limit?: number; from?: string; to?: string },
  ) => {
    const params = new URLSearchParams();
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    if (o?.limit != null) params.set('limit', String(o.limit));
    if (o?.from) params.set('from', o.from);
    if (o?.to)   params.set('to', o.to);
    const qs = params.toString();
    return http<AttentionHistoryEntryDto[]>(
      `/api/executions/${encodeURIComponent(id)}/attention/history${qs ? `?${qs}` : ''}`,
    );
  },
  executionHealthAnomalies: (id: string, opts?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to)   params.set('to', opts.to);
    const qs = params.toString();
    return http<HealthAnomalyDto[]>(
      `/api/executions/${encodeURIComponent(id)}/health/anomalies${qs ? `?${qs}` : ''}`,
    );
  },
  agentsReliability: () =>
    http<AgentReliabilitySummaryDto[]>('/api/agents/reliability'),
};