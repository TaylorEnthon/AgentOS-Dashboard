/**
 * Tiny typed API client. The backend serves `/api/*` on the same origin
 * (or proxied via vite in dev), so we use relative URLs.
 */
import type { AgentType } from '@agentos/shared';

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
  }>;
  events: Array<{
    id: string;
    sessionId: string;
    agentId: string;
    type: string;
    timestamp: string;
    detail?: string | null;
    meta?: Record<string, unknown>;
  }>;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}`);
  }
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
  refresh: () => http<{ ok: boolean; ts: string; reports: Array<{ agentId: string; sessions: number; usage: number; events: number; projects: number; ms: number; error?: string }> }>('/api/refresh', { method: 'POST' }),
  settings: () => http<SettingsDto>('/api/settings'),
  saveSettings: (s: Partial<SettingsDto>) => http<SettingsDto>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
};