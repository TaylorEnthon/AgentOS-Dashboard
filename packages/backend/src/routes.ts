import type { FastifyInstance } from 'fastify';
import { Db } from './db.js';
import { Scheduler } from './scheduler.js';
import { DEFAULT_PRICING } from '@agentos/shared';
import type { SettingsStore } from './settings.js';
import type { ConfidenceLevel } from '@agentos/shared';
import { eventBus, type RealtimeEvent } from './event-bus.js';
import { deriveAgentStatus, type AgentStatusRow } from './agent-status.js';

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  scheduler: Scheduler,
  settings: SettingsStore,
): void {
  app.get('/api/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    version: '0.6.0',
  }));

  app.get('/api/overview', async () => {
    const ov = db.overview();
    const agents = db.listAgents();
    const recent = db.listSessions({ limit: 12 });
    return {
      totalAgents: agents.length,
      enabledAgents: agents.filter((a) => a.enabled).length,
      ...ov,
      byAgent: ov.byAgent.map((b) => {
        const a = agents.find((x) => x.id === b.agentId);
        return { ...b, agentType: a?.type ?? 'custom', name: a?.name ?? b.agentId };
      }),
      recentSessions: recent.map(rowToSessionDto),
      daily: fillDailyGaps(ov.daily),
    };
  });

  app.get('/api/agents', async () => {
    const agents = db.listAgents();
    const ov = db.overview();
    return agents.map((a) => {
      const stats = ov.byAgent.find((b) => b.agentId === a.id);
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        dataDir: a.data_dir,
        enabled: !!a.enabled,
        capabilities: a.capabilities ? JSON.parse(a.capabilities) : [],
        lastScannedAt: a.last_scanned_at,
        sessions: stats?.sessions ?? 0,
        tokens: stats?.tokens ?? 0,
        cost: stats?.cost ?? 0,
      };
    });
  });

  /* ---------------- v0.4 runtime status ---------------- */

  app.get('/api/agents/status', async () => {
    return deriveAgentStatus(db.raw);
  });

  /* ---------------- existing endpoints ---------------- */

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const row = db.getAgent(req.params.id);
    if (!row) return reply.code(404).send({ error: 'agent not found' });
    const sessions = db.listSessions({ agentId: row.id, limit: 100 });
    const ov = db.overview();
    const stats = ov.byAgent.find((b) => b.agentId === row.id);
    return {
      ...rowToAgentDto(row),
      sessions: sessions.map(rowToSessionDto),
      totals: stats ?? { sessions: 0, tokens: 0, cost: 0 },
    };
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/agents/:id',
    async (req, reply) => {
      const row = db.getAgent(req.params.id);
      if (!row) return reply.code(404).send({ error: 'agent not found' });
      if (typeof req.body?.enabled === 'boolean') {
        db.setAgentEnabled(row.id, req.body.enabled);
      }
      return rowToAgentDto(db.getAgent(row.id)!);
    },
  );

  app.get<{ Querystring: { agent?: string; project?: string; limit?: string; status?: string } }>(
    '/api/sessions',
    async (req) => {
      const { agent, project, limit, status } = req.query;
      return db.listSessions({
        agentId: agent,
        project,
        status,
        limit: limit ? Number(limit) : undefined,
      }).map(rowToSessionDto);
    },
  );

  /* ---------- v0.5 timeline ---------- */

  app.get<{
    Querystring: {
      agent?: string;
      project?: string;
      session?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
  }>('/api/timeline', async (req) => {
    const { agent, project, session, from, to, limit } = req.query;
    return db.listTimeline({
      agentId: agent,
      project,
      sessionId: session,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const row = db.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: 'session not found' });
    return {
      ...rowToSessionDto(row),
      usage: db.listUsageForSession(row.id),
      events: db.listEventsForSession(row.id).map(rowToEventDto),
    };
  });

  /* ---------------- v0.6 Git integration ---------------- */

  app.get<{ Params: { id: string } }>('/api/git/sessions/:id', async (req, reply) => {
    const session = db.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const project = session.project_display || session.project;
    if (!project) {
      return { repo: null, commits: [], reason: 'session has no project' };
    }
    const { getGitSessionInfo } = await import('./git-service.js');
    try {
      return await getGitSessionInfo(project, session.start_time, session.end_time ?? undefined);
    } catch (err) {
      app.log.warn({ err, sessionId: req.params.id }, 'git projection failed');
      return reply.code(500).send({ error: 'git projection failed', detail: String(err) });
    }
  });

  app.get('/api/projects', async () => db.listProjects());

  app.post<{ Body: { forceFull?: boolean } }>('/api/refresh', async (req) => {
    const forceFull = req.body?.forceFull === true;
    const reports = await scheduler.scanAll('manual');
    return { ok: true, ts: new Date().toISOString(), mode: forceFull ? 'full' : 'auto', reports };
  });

  /* ---------------- v0.2 endpoints ---------------- */

  app.get('/api/data-health', async () => db.dataHealth());

  app.get<{ Querystring: { provider?: string } }>('/api/ingestion-files', async (req, reply) => {
    const provider = req.query.provider as import('@agentos/shared').AgentType | undefined;
    if (provider && !['claude-code', 'codex', 'grok', 'gemini', 'hermes', 'custom'].includes(provider)) {
      return reply.code(400).send({ error: 'invalid provider' });
    }
    return db.listIngestionFiles(provider);
  });

  /* ---------------- v0.4 SSE stream ---------------- */

  app.get('/api/events/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    // Hint reverse proxies / browsers to flush immediately.
    reply.raw.flushHeaders?.();

    const send = (ev: RealtimeEvent): void => {
      try {
        reply.raw.write(`event: ${ev.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* socket closed */
      }
    };

    // Heartbeat keeps proxies + browsers happy; 15s is a good middle ground.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: keep-alive ${Date.now()}\n\n`);
      } catch {
        /* socket closed */
      }
    }, 15_000);

    const unsub = eventBus.subscribe(send);
    // Also send an initial snapshot of agent statuses so the UI can paint
    // something immediately even before any scan completes.
    send({
      type: 'agent_status',
      ts: new Date().toISOString(),
      agent: '__snapshot__',
      status: 'unknown',
    });
    for (const row of deriveAgentStatus(db.raw)) {
      send({
        type: 'agent_status',
        ts: new Date().toISOString(),
        agent: row.agent,
        status: row.status,
        lastActivity: row.lastActivity,
        lastProject: row.lastProject,
        lastAction: row.lastAction,
      });
    }

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    });

    // Returning the reply tells Fastify the response is being streamed
    // and not to auto-serialize.
    return reply;
  });

  /* ---------------- settings ---------------- */

  app.get('/api/settings', async () => {
    const s = await settings.load();
    return { ...s, defaultPricing: DEFAULT_PRICING };
  });

  app.put<{ Body: Record<string, unknown> }>('/api/settings', async (req) => {
    const partial = req.body ?? {};
    const next = await settings.update(partial as Record<string, never>);
    if (typeof partial.pollIntervalSec === 'number') {
      db.setSetting('pollIntervalSec', JSON.stringify(partial.pollIntervalSec));
    }
    if (partial.pricingOverrides) db.setSetting('pricingOverrides', JSON.stringify(partial.pricingOverrides));
    if (partial.dataDirOverrides) db.setSetting('dataDirOverrides', JSON.stringify(partial.dataDirOverrides));
    if (partial.enabledAgents) db.setSetting('enabledAgents', JSON.stringify(partial.enabledAgents));
    settings.setLivePricingOverrides(next.pricingOverrides);
    return next;
  });

  app.get('/api/pricing', async () => {
    const s = await settings.load();
    return { defaults: DEFAULT_PRICING, overrides: s.pricingOverrides, effective: { ...DEFAULT_PRICING, ...s.pricingOverrides } };
  });
}

function rowToSessionDto(r: import('./db.js').SessionRow) {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentType: r.agent_id.split(':')[0],
    externalId: r.external_id,
    project: r.project,
    projectDisplay: r.project_display,
    title: r.title,
    startTime: r.start_time,
    endTime: r.end_time,
    status: r.status,
    model: r.model,
    messageCount: r.message_count,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalTokens: r.total_tokens,
    estimatedCost: r.estimated_cost,
    fileOps: r.file_ops,
    toolCalls: r.tool_calls,
    usageConfidence: r.usage_confidence ?? undefined,
    costConfidence: r.cost_confidence ?? undefined,
    source: r.source_file
      ? {
          sourceFile: r.source_file,
          sourceProvider: r.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
          sourceId: r.source_id ?? r.id,
          collectedAt: r.collected_at ?? '',
        }
      : undefined,
  };
}

function rowToEventDto(r: import('./db.js').EventRow) {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    type: r.type,
    timestamp: r.timestamp,
    detail: r.detail,
    meta: r.meta ? JSON.parse(r.meta) : undefined,
    source: r.source_file
      ? {
          sourceFile: r.source_file,
          sourceProvider: r.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
          sourceId: r.source_id ?? r.id,
          collectedAt: r.collected_at ?? '',
        }
      : undefined,
  };
}

function rowToAgentDto(r: import('./db.js').AgentRow) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    dataDir: r.data_dir,
    enabled: !!r.enabled,
    capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
    lastScannedAt: r.last_scanned_at,
  };
}

function fillDailyGaps(rows: Array<{ date: string; tokens: number; cost: number; sessions: number }>): Array<{ date: string; tokens: number; cost: number; sessions: number }> {
  if (rows.length === 0) return [];
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: typeof rows = [];
  const start = new Date(rows[0].date);
  const end = new Date(rows[rows.length - 1].date);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    out.push(map.get(k) ?? { date: k, tokens: 0, cost: 0, sessions: 0 });
  }
  return out;
}

export type { RealtimeEvent, AgentStatusRow };

// Re-export for type completeness
export type { ConfidenceLevel };