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

interface GrokPromptHistoryRecord {
  timestamp?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  type?: string;
  content?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  tool_call?: { name?: string };
}

export function decodeGrokProjectDir(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export class GrokCollector extends BaseCollector {
  readonly type: AgentType = 'grok';
  readonly displayName = 'Grok Build';
  readonly defaultCapabilities = ['chat', 'tools', 'workflows'];

  async resolveDataDir(userOverride?: string): Promise<string | null> {
    const candidates = [
      userOverride,
      process.env.GROK_HOME,
      path.join(homeDir(), '.grok'),
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
    const sessionsDir = path.join(agent.dataDir, 'sessions');
    if (!(await this.isDir(sessionsDir))) {
      return { agentId: agent.id, collectedAt, sessions: [], usage: [], events: [], projects: [], files: [] };
    }

    const sessions: AgentSession[] = [];
    const usage: UsageRecord[] = [];
    const events: ActivityEvent[] = [];
    const projectsMap = new Map<string, { path: string; displayName: string; lastSeen: string }>();
    const files: FileFingerprint[] = [];

    const projectDirs = (await fs.readdir(sessionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(sessionsDir, e.name));

    const maxFiles = opts.maxFiles ?? 5000;
    let fileCount = 0;

    for (const projDir of projectDirs) {
      if (fileCount >= maxFiles) break;
      const projectName = path.basename(projDir);
      const projectDisplay = decodeGrokProjectDir(projectName);
      const projectKey = projectDisplay;

      const found = await listFilesByExt(projDir, ['jsonl', 'ndjson'], { max: maxFiles - fileCount });
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
        await this.parseSessionFile(
          file, projectKey, projectDisplay, agent.id, collectedAt,
          sessions, usage, events, pricing,
        );
        files.push(buildFingerprint(file, fp, {
          sessions: sessions.length - before.sessions,
          usageRecords: usage.length - before.usage,
          events: events.length - before.events,
        }));
      }

      if (sessions.some((s) => s.project === projectKey)) {
        const seen = sessions
          .filter((s) => s.project === projectKey)
          .reduce((m, s) => Math.max(m, Date.parse(s.startTime) || 0), 0);
        projectsMap.set(projectKey, {
          path: projectKey,
          displayName: projectDisplay,
          lastSeen: seen ? new Date(seen).toISOString() : new Date().toISOString(),
        });
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

  private async parseSessionFile(
    file: string,
    projectKey: string,
    projectDisplay: string,
    agentId: string,
    collectedAt: string,
    sessions: AgentSession[],
    usage: UsageRecord[],
    events: ActivityEvent[],
    pricing: Record<string, ModelPricing>,
  ): Promise<void> {
    let externalId = '';
    let sessionStart: string | undefined;
    let sessionEnd: string | undefined;
    let lastModel: string | undefined;
    let messageCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let fileOps = 0;
    let toolCalls = 0;
    let worstUsageConf: ConfidenceLevel = 'exact';
    let worstCostConf: ConfidenceLevel = 'exact';

    const parent = path.basename(path.dirname(file));
    if (parent) externalId = parent;

    await forEachJsonl<GrokPromptHistoryRecord>(file, (rec, _raw, _line) => {
      const ts = normalizeTimestamp(rec.timestamp);
      if (ts) {
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }
      if (rec.session_id && !externalId) externalId = rec.session_id;
      if (rec.model) lastModel = rec.model;

      // Note: Grok prompt_history has one record per turn, so collisions
      // here are unlikely — but use the record's own array index if any.
      if (rec.role === 'user' || rec.role === 'assistant' || rec.type === 'message') {
        messageCount++;
        const evId = `${agentId}:${externalId}:${_line}:msg`;
        events.push({
          id: evId,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          type: 'message',
          timestamp: ts ?? new Date().toISOString(),
          detail: typeof rec.content === 'string' ? rec.content.slice(0, 200) : undefined,
          source: buildSourceMeta('grok', file, evId, collectedAt),
        });
      }

      if (rec.tool_call) {
        toolCalls++;
        const name = rec.tool_call.name ?? 'unknown';
        if (/file|read|write|edit/i.test(name)) fileOps++;
        const evId = `${agentId}:${externalId}:${_line}:tc`;
        events.push({
          id: evId,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          type: 'tool-call',
          timestamp: ts ?? new Date().toISOString(),
          detail: name,
          source: buildSourceMeta('grok', file, evId, collectedAt),
        });
      }

      const u = rec.usage;
      if (u) {
        const it = u.input_tokens ?? 0;
        const ot = u.output_tokens ?? 0;
        const cr = u.cache_read_input_tokens ?? 0;
        const cw = u.cache_creation_input_tokens ?? 0;
        inputTokens += it;
        outputTokens += ot;
        cacheRead += cr;
        cacheWrite += cw;
        const breakdown = computeCost(rec.model, it, ot, cr, cw, pricing);
        worstUsageConf = worseConfidence(worstUsageConf, deriveUsageConfidence(it, ot, true));
        worstCostConf = worseConfidence(worstCostConf, breakdown.costConfidence);
        const usageId = `${agentId}:${externalId}:${_line}:u`;
        usage.push({
          id: usageId,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          model: rec.model ?? 'unknown',
          inputTokens: it,
          outputTokens: ot,
          cacheReadTokens: cr,
          cacheWriteTokens: cw,
          totalTokens: it + ot + cr + cw,
          estimatedCost: breakdown.total,
          timestamp: ts ?? new Date().toISOString(),
          usageConfidence: deriveUsageConfidence(it, ot, true),
          costConfidence: breakdown.costConfidence,
          unknownModel: breakdown.costConfidence === 'unknown',
          source: buildSourceMeta('grok', file, usageId, collectedAt),
        });
      } else {
        // line with role but no usage block → tokens for this turn are unknown
        if (rec.role === 'assistant') worstUsageConf = worseConfidence(worstUsageConf, 'unknown');
      }
    });

    if (!externalId || !sessionStart) return;
    const totalBreakdown = computeCost(lastModel, inputTokens, outputTokens, cacheRead, cacheWrite, pricing);
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
      totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
      estimatedCost: totalBreakdown.total,
      fileOps,
      toolCalls,
      usageConfidence: worstUsageConf,
      costConfidence: worstCostConf,
      source: buildSourceMeta('grok', file, sessionId, collectedAt),
    });
  }
}