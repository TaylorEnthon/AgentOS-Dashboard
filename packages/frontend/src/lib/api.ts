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

export interface AgentExecutionDto {
  id: string;
  sessionId: string;
  agentId: string;
  agentType: AgentType;
  project: string;
  projectDisplay: string;
  title?: string | null;
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
  executions: (params: { agent?: string; session?: string; project?: string; limit?: number } = {}) => {
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
};