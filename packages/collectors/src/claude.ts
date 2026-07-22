import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BaseCollector,
  decodeClaudeProjectDir,
  forEachJsonl,
  homeDir,
  listFilesByExt,
  makeSessionId,
  normalizeTimestamp,
  type ScanOptions,
} from './base.js';
import { computeCost, type ModelPricing, type AgentType, type RawScanResult, type AgentSession, type UsageRecord, type ActivityEvent } from '@agentos/shared';

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
  // queue-operation
  operation?: string;
  // custom-title
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

  async scan(agent: { id: string; type: AgentType; dataDir: string }, opts: ScanOptions = {}): Promise<RawScanResult> {
    const pricing = opts.pricing ?? {};
    const projectsDir = path.join(agent.dataDir, 'projects');
    if (!(await this.isDir(projectsDir))) {
      return { agentId: agent.id, sessions: [], usage: [], events: [], projects: [] };
    }

    const projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));

    const sessions: AgentSession[] = [];
    const usage: UsageRecord[] = [];
    const events: ActivityEvent[] = [];
    const projectsMap = new Map<string, { path: string; displayName: string; lastSeen: string }>();

    const maxFiles = opts.maxFiles ?? 5000;
    let fileCount = 0;

    for (const projDir of projectDirs) {
      if (fileCount >= maxFiles) break;
      const projectName = path.basename(projDir);
      const projectDisplay = decodeClaudeProjectDir(projectName);
      const projectKey = projectDisplay;

      const files = await listFilesByExt(projDir, ['jsonl', 'ndjson'], { max: maxFiles - fileCount });
      for (const file of files) {
        if (fileCount >= maxFiles) break;
        fileCount++;
        await this.parseSessionFile(file, projectKey, projectDisplay, agent.id, sessions, usage, events, pricing);
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
      sessions,
      usage,
      events,
      projects: Array.from(projectsMap.values()),
    };
  }

  private async parseSessionFile(
    file: string,
    projectKey: string,
    projectDisplay: string,
    agentId: string,
    sessions: AgentSession[],
    usage: UsageRecord[],
    events: ActivityEvent[],
    pricing: Record<string, ModelPricing>,
  ): Promise<void> {
    // Pre-scan to determine session start/end and aggregate per-session stats.
    let externalId = '';
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

    await forEachJsonl<ClaudeRecord>(file, (rec, _raw, _line) => {
      const ts = normalizeTimestamp(rec.timestamp);
      if (rec.sessionId && !externalId) externalId = rec.sessionId;
      if (ts) {
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }
      if (rec.type === 'custom-title' && rec.customTitle) title = rec.customTitle;

      if (rec.type === 'user') {
        messageCount++;
        events.push({
          id: `${agentId}:${rec.sessionId}:${_line}:user`,
          sessionId: makeSessionId(agentId, rec.sessionId ?? ''),
          agentId,
          type: 'message',
          timestamp: ts ?? new Date().toISOString(),
          detail: rec.content?.slice(0, 200),
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
          const cost = computeCost(rec.message.model, it, ot, cr, cw, pricing);
          usage.push({
            id: `${agentId}:${rec.sessionId}:${_line}:u`,
            sessionId: makeSessionId(agentId, rec.sessionId ?? ''),
            agentId,
            model: rec.message.model ?? 'unknown',
            inputTokens: it,
            outputTokens: ot,
            cacheReadTokens: cr,
            cacheWriteTokens: cw,
            totalTokens: total,
            estimatedCost: cost.total,
            timestamp: ts ?? new Date().toISOString(),
          });
        }
        for (const block of rec.message.content ?? []) {
          if (block.type === 'tool_use') {
            toolCalls++;
            const toolName = block.name ?? 'unknown';
            if (/read|file/i.test(toolName)) fileOps++;
            events.push({
              id: `${agentId}:${rec.sessionId}:${_line}:${block.id ?? toolName}`,
              sessionId: makeSessionId(agentId, rec.sessionId ?? ''),
              agentId,
              type: 'tool-call',
              timestamp: ts ?? new Date().toISOString(),
              detail: toolName,
              meta: typeof block.input === 'object' ? (block.input as Record<string, unknown>) : undefined,
            });
          }
        }
      }
    });

    if (!externalId || !sessionStart) return;
    const totalCost = computeCost(lastModel, inputTokens, outputTokens, cacheRead, cacheWrite, pricing).total;

    sessions.push({
      id: makeSessionId(agentId, externalId),
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
      estimatedCost: totalCost,
      fileOps,
      toolCalls,
    });
  }
}