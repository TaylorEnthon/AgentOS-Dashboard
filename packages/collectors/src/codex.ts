import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BaseCollector,
  buildFingerprint,
  buildSourceMeta,
  forEachJsonl,
  hashFile,
  homeDir,
  isFileUnchanged,
  listFilesByExt,
  makeSessionId,
  normalizeTimestamp,
  type ScanOptions,
} from './base.js';
import {
  computeCost,
  deriveUsageConfidence,
  worseConfidence,
  type ModelPricing,
  type AgentType,
  type RawScanResult,
  type AgentSession,
  type UsageRecord,
  type ActivityEvent,
  type ConfidenceLevel,
  type FileFingerprint,
} from '@agentos/shared';

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
    cwd?: string;
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

  async scan(
    agent: { id: string; type: AgentType; dataDir: string },
    opts: ScanOptions = {},
  ): Promise<RawScanResult> {
    const pricing = opts.pricing ?? {};
    const collectedAt = new Date().toISOString();
    const sessions: AgentSession[] = [];
    const usage: UsageRecord[] = [];
    const events: ActivityEvent[] = [];
    const projectsMap = new Map<string, { path: string; displayName: string; lastSeen: string }>();
    const files: FileFingerprint[] = [];

    const searchRoots = [
      path.join(agent.dataDir, 'archived_sessions'),
      path.join(agent.dataDir, 'sessions'),
    ];

    const maxFiles = opts.maxFiles ?? 2000;
    let fileCount = 0;

    for (const root of searchRoots) {
      if (!(await this.isDir(root))) continue;
      const found = await listFilesByExt(root, ['jsonl', 'ndjson'], { max: maxFiles - fileCount });
      for (const file of found) {
        if (fileCount >= maxFiles) break;
        fileCount++;

        const fp = await hashFile(file);
        const prior = opts.priorFiles?.get(file);
        if (opts.mode === 'incremental' && isFileUnchanged(fp, prior)) continue;

        const before = {
          sessions: sessions.length,
          usage: usage.length,
          events: events.length,
        };
        await this.parseRollout(
          file, agent.id, collectedAt, sessions, usage, events, projectsMap, pricing,
        );
        files.push(buildFingerprint(file, fp, {
          sessions: sessions.length - before.sessions,
          usageRecords: usage.length - before.usage,
          events: events.length - before.events,
        }));
      }
    }

    return {
      agentId: agent.id,
      collectedAt,
      sessions,
      usage,
      events,
      projects: Array.from(projectsMap.values()),
      files,
    };
  }

  private async parseRollout(
    file: string,
    agentId: string,
    collectedAt: string,
    sessions: AgentSession[],
    usage: UsageRecord[],
    events: ActivityEvent[],
    projectsMap: Map<string, { path: string; displayName: string; lastSeen: string }>,
    pricing: Record<string, ModelPricing>,
  ): Promise<void> {
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
    let worstUsageConf: ConfidenceLevel = 'exact';
    let worstCostConf: ConfidenceLevel = 'exact';

    // Codex rollout filename already encodes the session uuid; treat it as
    // the authoritative id so usage/event IDs are stable even when
    // individual items omit `payload.id`.
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

      // (don't overwrite the file-derived externalId with payload.id — items
      // that lack payload.id would otherwise collide with other items)
      if (payload.cwd) {
        projectKey = payload.cwd;
        projectDisplay = payload.cwd;
      }

      const items = payload.items ?? [];
      for (let ii = 0; ii < items.length; ii++) {
        const it = items[ii];
        if (it.type === 'message' || it.role === 'user' || it.role === 'assistant') {
          messageCount++;
        }
        if (it.function_call) {
          toolCalls++;
          const name = it.function_call.name ?? 'unknown';
          if (/file|read|write|edit/i.test(name)) fileOps++;
          const evId = `${agentId}:${externalId}:${_line}:fc${ii}`;
          events.push({
            id: evId,
            sessionId: makeSessionId(agentId, externalId),
            agentId,
            type: 'tool-call',
            timestamp: ts ?? new Date().toISOString(),
            detail: name,
            source: buildSourceMeta('codex', file, evId, collectedAt),
          });
        }
      }

      const model = payload.model ?? payload.info?.model ?? payload.response?.metadata?.model;
      if (model) lastModel = model;

      const resp = payload.response;
      if (resp?.usage) {
        const it = resp.usage.input_tokens ?? 0;
        const ot = resp.usage.output_tokens ?? 0;
        const total = resp.usage.total_tokens ?? it + ot;
        inputTokens += it;
        outputTokens += ot;
        const breakdown = computeCost(model, it, ot, 0, 0, pricing);
        worstUsageConf = worseConfidence(worstUsageConf, deriveUsageConfidence(it, ot, true));
        worstCostConf = worseConfidence(worstCostConf, breakdown.costConfidence);
        const usageId = `${agentId}:${externalId}:${_line}:u`;
        usage.push({
          id: usageId,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          model: model ?? 'unknown',
          inputTokens: it,
          outputTokens: ot,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: total,
          estimatedCost: breakdown.total,
          timestamp: ts ?? new Date().toISOString(),
          usageConfidence: deriveUsageConfidence(it, ot, true),
          costConfidence: breakdown.costConfidence,
          unknownModel: breakdown.costConfidence === 'unknown',
          source: buildSourceMeta('codex', file, usageId, collectedAt),
        });
      }

      if (!projectKey) {
        projectKey = 'codex:default';
        projectDisplay = 'Codex (no project)';
      }
    });

    if (!externalId || !sessionStart) return;

    const totalBreakdown = computeCost(lastModel, inputTokens, outputTokens, 0, 0, pricing);
    worstCostConf = worseConfidence(worstCostConf, totalBreakdown.costConfidence);

    const sessionId = makeSessionId(agentId, externalId);
    sessions.push({
      id: sessionId,
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
      estimatedCost: totalBreakdown.total,
      fileOps,
      toolCalls,
      usageConfidence: worstUsageConf,
      costConfidence: worstCostConf,
      source: buildSourceMeta('codex', file, sessionId, collectedAt),
    });

    projectsMap.set(projectKey, {
      path: projectKey,
      displayName: projectDisplay,
      lastSeen: sessionEnd ?? sessionStart,
    });
  }
}