import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BaseCollector,
  buildFingerprint,
  buildSourceMeta,
  decodeClaudeProjectDir,
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
} from '@agentos/shared';

interface ClaudeAssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeAssistantMessage {
  id?: string;
  model?: string;
  content?: ClaudeContentBlock[];
  usage?: ClaudeAssistantUsage;
  stop_reason?: string | null;
}

interface ClaudeRecord {
  type: string;
  sessionId?: string;
  timestamp?: string;
  message?: ClaudeAssistantMessage;
  content?: string;
  toolUseID?: string;
  toolName?: string;
  isMeta?: boolean;
  operation?: string;
  customTitle?: string;
}

export class ClaudeCollector extends BaseCollector {
  readonly type: AgentType = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly defaultCapabilities = ['chat', 'tools', 'mcp', 'file-edit'];

  async resolveDataDir(userOverride?: string): Promise<string | null> {
    const candidates = [
      userOverride,
      process.env.CLAUDE_CONFIG_DIR,
      path.join(homeDir(), '.claude'),
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
    const projectsDir = path.join(agent.dataDir, 'projects');
    if (!(await this.isDir(projectsDir))) {
      return { agentId: agent.id, collectedAt, sessions: [], usage: [], events: [], projects: [], files: [] };
    }

    const projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));

    const sessions: AgentSession[] = [];
    const usage: UsageRecord[] = [];
    const events: ActivityEvent[] = [];
    const projectsMap = new Map<string, { path: string; displayName: string; lastSeen: string }>();
    const files: import('@agentos/shared').FileFingerprint[] = [];

    const maxFiles = opts.maxFiles ?? 5000;
    let fileCount = 0;

    for (const projDir of projectDirs) {
      if (fileCount >= maxFiles) break;
      const projectName = path.basename(projDir);
      const projectDisplay = decodeClaudeProjectDir(projectName);
      const projectKey = projectDisplay;

      const found = await listFilesByExt(projDir, ['jsonl', 'ndjson'], { max: maxFiles - fileCount });
      for (const file of found) {
        if (fileCount >= maxFiles) break;
        fileCount++;

        const fp = await hashFile(file);
        const prior = opts.priorFiles?.get(file);
        if (opts.mode === 'incremental' && isFileUnchanged(fp, prior)) {
          continue; // unchanged — skip parse entirely
        }

        const before = {
          sessions: sessions.length,
          usage: usage.length,
          events: events.length,
        };
        await this.parseSessionFile(
          file, projectKey, projectDisplay, agent.id, collectedAt,
          sessions, usage, events, pricing,
        );
        const counts = {
          sessions: sessions.length - before.sessions,
          usageRecords: usage.length - before.usage,
          events: events.length - before.events,
        };
        files.push(buildFingerprint(file, fp, counts));
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
    // Claude's file naming is `<session-uuid>.jsonl`; treat the filename as
    // the authoritative session id so usage/event IDs are unique even when
    // individual JSONL lines happen to omit `sessionId`.
    let externalId = path.basename(file).replace(/\.[^.]+$/, '');
    let sessionStart: string | undefined;
    let sessionEnd: string | undefined;
    let title: string | undefined;
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
    let lastModelUnknown = false;

    await forEachJsonl<ClaudeRecord>(file, (rec, _raw, _line) => {
      const ts = normalizeTimestamp(rec.timestamp);
      // (externalId is already set from the filename — do not overwrite)
      if (ts) {
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }
      if (rec.type === 'custom-title' && rec.customTitle) title = rec.customTitle;

      if (rec.type === 'user') {
        messageCount++;
        const evId = `${agentId}:${externalId}:${_line}:user`;
        events.push({
          id: evId,
          sessionId: makeSessionId(agentId, externalId),
          agentId,
          type: 'message',
          timestamp: ts ?? new Date().toISOString(),
          detail: rec.content?.slice(0, 200),
          source: buildSourceMeta('claude-code', file, evId, collectedAt),
        });
      } else if (rec.type === 'assistant' && rec.message) {
        messageCount++;
        if (rec.message.model) lastModel = rec.message.model;
        const u = rec.message.usage;
        if (u) {
          const it = u.input_tokens ?? 0;
          const ot = u.output_tokens ?? 0;
          const cr = u.cache_read_input_tokens ?? 0;
          const cw = u.cache_creation_input_tokens ?? 0;
          inputTokens += it;
          outputTokens += ot;
          cacheRead += cr;
          cacheWrite += cw;
          const total = it + ot + cr + cw;
          const breakdown = computeCost(rec.message.model, it, ot, cr, cw, pricing);
          worstUsageConf = worseConfidence(worstUsageConf, deriveUsageConfidence(it, ot, true));
          worstCostConf = worseConfidence(worstCostConf, breakdown.costConfidence);
          lastModelUnknown = breakdown.costConfidence === 'unknown';
          const usageId = `${agentId}:${externalId}:${_line}:u`;
          usage.push({
            id: usageId,
            sessionId: makeSessionId(agentId, externalId),
            agentId,
            model: rec.message.model ?? 'unknown',
            inputTokens: it,
            outputTokens: ot,
            cacheReadTokens: cr,
            cacheWriteTokens: cw,
            totalTokens: total,
            estimatedCost: breakdown.total,
            timestamp: ts ?? new Date().toISOString(),
            usageConfidence: deriveUsageConfidence(it, ot, true),
            costConfidence: breakdown.costConfidence,
            unknownModel: breakdown.costConfidence === 'unknown',
            source: buildSourceMeta('claude-code', file, usageId, collectedAt),
          });
        } else {
          worstUsageConf = worseConfidence(worstUsageConf, 'unknown');
        }
        const blocks = rec.message.content ?? [];
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi];
          if (block.type === 'tool_use') {
            toolCalls++;
            const toolName = block.name ?? 'unknown';
            if (/read|file/i.test(toolName)) fileOps++;
            const evId = `${agentId}:${externalId}:${_line}:b${bi}`;
            events.push({
              id: evId,
              sessionId: makeSessionId(agentId, externalId),
              agentId,
              type: 'tool-call',
              timestamp: ts ?? new Date().toISOString(),
              detail: toolName,
              meta: typeof block.input === 'object' ? (block.input as Record<string, unknown>) : undefined,
              source: buildSourceMeta('claude-code', file, evId, collectedAt),
            });
          }
        }
      }
    });

    if (!externalId || !sessionStart) return;
    const totalBreakdown = computeCost(lastModel, inputTokens, outputTokens, cacheRead, cacheWrite, pricing);
    if (totalBreakdown.costConfidence === 'unknown') lastModelUnknown = true;

    const sessionId = makeSessionId(agentId, externalId);
    sessions.push({
      id: sessionId,
      agentId,
      agentType: this.type,
      externalId,
      project: projectKey,
      projectDisplay,
      title,
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
      source: buildSourceMeta('claude-code', file, sessionId, collectedAt),
    });
  }
}