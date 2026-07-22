import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BaseCollector,
  forEachJsonl,
  homeDir,
  listFilesByExt,
  makeSessionId,
  normalizeTimestamp,
  type ScanOptions,
} from './base.js';
import { computeCost, type ModelPricing, type AgentType, type RawScanResult, type AgentSession, type UsageRecord, type ActivityEvent } from '@agentos/shared';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexResponse {
  usage?: CodexUsage;
  metadata?: { model?: string };
}

interface CodexMessage {
  role?: 'user' | 'assistant' | 'system' | 'tool';
  content?: unknown;
  function_call?: { name?: string; arguments?: string };
}

interface CodexItem {
  type?: string;
  role?: string;
  content?: unknown;
  function_call?: { name?: string; arguments?: string };
}

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    model?: string;
    messages?: CodexMessage[];
    items?: CodexItem[];
    response?: CodexResponse;
    info?: { model?: string };
  };
}

export class CodexCollector extends BaseCollector {
  readonly type: AgentType = 'codex';
  readonly displayName = 'Codex CLI';
  readonly defaultCapabilities = ['chat', 'tools', 'exec'];

  async resolveDataDir(userOverride?: string): Promise<string | null> {
    const candidates = [
      userOverride,
      process.env.CODEX_HOME,
      path.join(homeDir(), '.codex'),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (await this.isDir(c)) return c;
    }
    return null;
  }

  private async isDir(p: string): Promise<boolean> {
    try {
      const s = await fs.stat(p);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async scan(agent: { id: string; type: AgentType; dataDir: string }, opts: ScanOptions = {}): Promise<RawScanResult> {
    const pricing = opts.pricing ?? {};
    const sessions: AgentSession[] = [];
    const usage: UsageRecord[] = [];
    const events: ActivityEvent[] = [];
    const projectsMap = new Map<string, { path: string; displayName: string; lastSeen: string }>();

    const searchRoots = [
      path.join(agent.dataDir, 'archived_sessions'),
      path.join(agent.dataDir, 'sessions'),
    ];

    const maxFiles = opts.maxFiles ?? 2000;
    let fileCount = 0;

    for (const root of searchRoots) {
      if (!(await this.isDir(root))) continue;
      const files = await listFilesByExt(root, ['jsonl', 'ndjson'], { max: maxFiles - fileCount });
      for (const file of files) {
        if (fileCount >= maxFiles) break;
        fileCount++;
        await this.parseRollout(file, agent.id, sessions, usage, events, projectsMap, pricing);
      }
    }

    return {
      agentId: agent.id,
      sessions,
      usage,
      events,
      projects: Array.from(projectsMap.values()),
    };
  }

  private async parseRollout(
    file: string,
    agentId: string,
    sessions: AgentSession[],
    usage: UsageRecord[],
    events: ActivityEvent[],
    projectsMap: Map<string, { path: string; displayName: string; lastSeen: string }>,
    pricing: Record<string, ModelPricing>,
  ): Promise<void> {
    // Rollout file name pattern: rollout-<isoTs>-<uuid>.jsonl
    // External session id = uuid portion; project = first payload.cwd or extracted from payload.
    let externalId = '';
    let sessionStart: string | undefined;
    let sessionEnd: string | undefined;
    let lastModel: string | undefined;
    let messageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let fileOps = 0;
    let toolCalls = 0;
    let projectKey = '';
    let projectDisplay = '';

    // Try extracting uuid from filename
    const fname = path.basename(file);
    const m = fname.match(/rollout-(.+?)-([0-9a-f-]{36})\.jsonl$/i);
    if (m) externalId = m[2];

    await forEachJsonl<CodexRecord>(file, (rec, _raw, _line) => {
      const ts = normalizeTimestamp(rec.timestamp);
      if (ts) {
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }
      const payload = rec.payload;
      if (!payload) return;

      // Session id (if available in payload)
      if (payload.id && payload.id !== externalId) externalId = externalId || payload.id;

      const items = payload.items ?? [];
      for (const it of items) {
        if (it.type === 'message' || it.role === 'user' || it.role === 'assistant') {
          messageCount++;
        }
        if (it.function_call) {
          toolCalls++;
          const name = it.function_call.name ?? 'unknown';
          if (/file|read|write|edit/i.test(name)) fileOps++;
          events.push({
            id: `${agentId}:${externalId}:${_line}:fc`,
            sessionId: makeSessionId(agentId, externalId),
            agentId,
            type: 'tool-call',
            timestamp: ts ?? new Date().toISOString(),
            detail: name,
          });
        }
      }

      // Top-level model & response usage
      const model = payload.model ?? payload.info?.model ?? payload.response?.metadata?.model;
      if (model) lastModel = model;

      const resp = payload.response;
      if (resp?.usage) {
        const it = resp.usage.input_tokens ?? 0;
        const ot = resp.usage.output_tokens ?? 0;
        const total = resp.usage.total_tokens ?? it + ot;
        inputTokens += it;
        outputTokens += ot;
        const cost = computeCost(model, it, ot, 0, 0, pricing);
        usage.push({
          id: `${agentId}:${externalId}:${_line}:u`,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          model: model ?? 'unknown',
          inputTokens: it,
          outputTokens: ot,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: total,
          estimatedCost: cost.total,
          timestamp: ts ?? new Date().toISOString(),
        });
      }

      // Try to detect project from first message cwd — Codex rollouts don't
      // always embed cwd, so we fall back to grouping by file parent dir.
      if (!projectKey) {
        // Heuristic: derive from sibling .codex/sessions/<project>/...
        // (no-op here; ingest layer will derive from file path if needed)
        projectKey = 'codex:default';
        projectDisplay = 'Codex (no project)';
      }
    });

    if (!externalId || !sessionStart) return;

    const totalCost = computeCost(lastModel, inputTokens, outputTokens, 0, 0, pricing).total;

    sessions.push({
      id: makeSessionId(agentId, externalId),
      agentId,
      agentType: this.type,
      externalId,
      project: projectKey,
      projectDisplay,
      title: undefined,
      startTime: sessionStart,
      endTime: sessionEnd,
      status: sessionEnd ? 'completed' : 'running',
      model: lastModel,
      messageCount,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCost: totalCost,
      fileOps,
      toolCalls,
    });

    projectsMap.set(projectKey, {
      path: projectKey,
      displayName: projectDisplay,
      lastSeen: sessionEnd ?? sessionStart,
    });
  }
}