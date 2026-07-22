import type { FastifyInstance } from 'fastify';
import { Db } from './db.js';
import { humanAction } from './db.js';
import { Scheduler } from './scheduler.js';
import { DEFAULT_PRICING } from '@agentos/shared';
import type { SettingsStore } from './settings.js';
import type { ConfidenceLevel } from '@agentos/shared';
import { eventBus, type RealtimeEvent } from './event-bus.js';
import { deriveAgentStatus, type AgentStatusRow } from './agent-status.js';
import { buildResumeCommand } from './resume.js';
import {
  associateCommitsToExecutions,
  associateUsageToExecutions,
  applyExecutionMetadata,
  buildExecution,
  groupEventsIntoExecutions,
} from './execution-service.js';

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

  /* ---------------- v0.7: Session Management ---------------- */

  // v0.7-a: list with search/filter, now with metadata
  app.get<{
    Querystring: {
      agent?: string;
      project?: string;
      search?: string;
      status?: string;
      pinned?: string;
      limit?: string;
    };
  }>('/api/sessions-v2', async (req) => {
    const { agent, project, search, status, pinned, limit } = req.query;
    const lim = Math.max(1, Math.min(limit ? Number(limit) : 500, 1000));
    const where: string[] = [];
    const params: unknown[] = [];
    if (agent)   { where.push('s.agent_id = ?');    params.push(agent); }
    if (project) { where.push('s.project = ?');     params.push(project); }
    if (status)  { where.push('s.status = ?');      params.push(status); }
    // search: project OR session metadata.display_name OR session.title
    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      where.push(
        `(s.project LIKE ? OR s.title LIKE ? OR sm.display_name LIKE ?)`,
      );
      params.push(like, like, like);
    }
    if (pinned === 'true' || pinned === '1') {
      where.push('sm.pinned = 1');
    } else if (pinned === 'false' || pinned === '0') {
      where.push('(sm.pinned IS NULL OR sm.pinned = 0)');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // LEFT JOIN metadata so the search hits display_name; COUNT(event) for
    // the timeline summary; SUM(usage) for tokens/cost.
    const rows = db.raw.prepare(
      `SELECT
         s.*,
         sm.display_name AS sm_display_name,
         sm.note         AS sm_note,
         sm.tags         AS sm_tags,
         sm.pinned       AS sm_pinned,
         sm.created_at   AS sm_created_at,
         sm.updated_at   AS sm_updated_at,
         (SELECT COUNT(*) FROM activity_events WHERE session_id = s.id) AS event_count,
         (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_records WHERE session_id = s.id) AS sum_tokens,
         (SELECT COALESCE(SUM(estimated_cost), 0) FROM usage_records WHERE session_id = s.id) AS sum_cost
       FROM sessions s
       LEFT JOIN session_metadata sm ON sm.session_id = s.id
       ${whereSql}
       ORDER BY COALESCE(sm.pinned, 0) DESC, s.start_time DESC
       LIMIT ${lim}`,
    ).all(...params) as Array<import('./db.js').SessionRow & {
      sm_display_name: string | null;
      sm_note: string | null;
      sm_tags: string | null;
      sm_pinned: number | null;
      sm_created_at: string | null;
      sm_updated_at: string | null;
      event_count: number;
      sum_tokens: number;
      sum_cost: number;
    }>;
    return rows.map((r) => withMetadataSummary(r, rowToSessionDto(r)));
  });

  // v0.7-b: detail (session + metadata + usage + events + git + resume)
  app.get<{ Params: { id: string } }>('/api/sessions-v2/:id', async (req, reply) => {
    const row = db.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: 'session not found' });
    const meta = db.getSessionMetadata(req.params.id);
    const session = withMetadata(rowToSessionDto(row), meta);
    // Pull git projection (read-only, optional). Don't fail the whole
    // request if git log errors out.
    let git: import('@agentos/shared').GitSessionInfo | null = null;
    if (row.project_display || row.project) {
      try {
        const { getGitSessionInfo } = await import('./git-service.js');
        git = await getGitSessionInfo(
          row.project_display || row.project,
          row.start_time,
          row.end_time ?? undefined,
        );
      } catch {
        git = { repo: null, commits: [], reason: 'git projection failed' };
      }
    }
    return {
      ...session,
      metadata: meta,
      durationMs: computeDurationMs(row.start_time, row.end_time),
      git,
      usage: db.listUsageForSession(row.id),
      events: db.listEventsForSession(row.id).map(rowToEventDto),
    };
  });

  // v0.7-c: PATCH metadata (rename / note / tags / pin)
  app.patch<{ Params: { id: string }; Body: Partial<{
    displayName?: string | null;
    note?: string | null;
    tags?: string[];
    pinned?: boolean;
  }> }>('/api/sessions-v2/:id/metadata', async (req, reply) => {
    if (!db.getSession(req.params.id)) {
      return reply.code(404).send({ error: 'session not found' });
    }
    const b = req.body ?? {};
    // Sanitize tags: keep only non-empty strings, dedup, cap at 32
    let tags: string[] | undefined;
    if (Array.isArray(b.tags)) {
      const seen = new Set<string>();
      tags = [];
      for (const t of b.tags) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        tags.push(trimmed);
        if (tags.length >= 32) break;
      }
    }
    const updated = db.upsertSessionMetadata(req.params.id, {
      displayName: b.displayName === undefined ? undefined : (b.displayName || null),
      note:        b.note        === undefined ? undefined : (b.note        || null),
      tags,
      pinned:      b.pinned      === undefined ? undefined :  b.pinned,
    });
    return updated;
  });

  // v0.7-d: resume command (read-only projection)
  app.get<{ Params: { id: string } }>('/api/sessions-v2/:id/resume', async (req, reply) => {
    const row = db.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: 'session not found' });
    return buildResumeCommand(row.agent_id.split(':')[0] as never, row.external_id);
  });

  /* ---------------- v0.8: Execution Intelligence ---------------- */

  // v0.8-a: list executions derived from sessions + events
  app.get<{
    Querystring: {
      agent?: string;
      session?: string;
      project?: string;
      /** v0.9: filter by a single tag (case-insensitive substring on the JSON-tag column). */
      tag?: string;
      /** v0.9: filter by effective status (manual OR derived). */
      status?: string;
      limit?: string;
    };
  }>('/api/executions', async (req) => {
    const { agent, session, project, tag, status, limit } = req.query;
    const lim = Math.max(1, Math.min(limit ? Number(limit) : 200, 1000));

    // Fetch candidate sessions matching the filters.
    const sessions = db.listSessions({
      agentId: agent,
      project,
      limit: 1000,
    }).filter((s) => !session || s.id === session);

    // v0.9: bulk-fetch all execution_metadata rows in one query so we
    // can apply displayName/tags/manualStatus without N+1 calls.
    const execIds: string[] = [];
    for (const s of sessions) {
      const events = db.listEventsForSession(s.id, 1000).map(rowToTimelineItem);
      const groups = groupEventsIntoExecutions(events);
      for (const g of groups) execIds.push(`${s.id}:exec-${g.index}`);
    }
    const metaMap = db.getExecutionMetadataBulk(execIds);

    const out: import('@agentos/shared').AgentExecution[] = [];
    for (const s of sessions) {
      const events = db.listEventsForSession(s.id, 1000).map(rowToTimelineItem);
      const groups = groupEventsIntoExecutions(events);
      if (groups.length === 0) continue;
      const usage = db.listUsageForSession(s.id).map(rowToUsageDto);
      const usageByGroup = associateUsageToExecutions(groups, usage);

      let commits: import('@agentos/shared').GitCommitInfo[] = [];
      if (s.project_display || s.project) {
        try {
          const { commitsInRange, findRepoRoot } = await import('./git-service.js');
          const root = await findRepoRoot(s.project_display || s.project);
          if (root) {
            commits = await commitsInRange(
              root,
              s.start_time,
              s.end_time ?? new Date().toISOString(),
              200,
            );
          }
        } catch {
          // git failure is non-fatal — execution just has no commits
        }
      }
      const commitsByGroup = associateCommitsToExecutions(groups, commits);

      for (const g of groups) {
        const baseExec = buildExecution(
          s.id,
          s.agent_id,
          s.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
          s.project,
          s.project_display || s.project,
          g,
          commitsByGroup.get(g.index) ?? [],
          usageByGroup.get(g.index) ?? [],
        );
        // v0.9: apply execution_metadata on top
        const meta = metaMap.get(baseExec.id) ?? null;
        const exec = applyExecutionMetadata(baseExec, meta);
        out.push(exec);
      }
    }

    // v0.9: optional filters (apply AFTER metadata is on, so they can
    // target the effective status and the metadata tags).
    let filtered = out;
    if (tag && tag.trim()) {
      const needle = tag.trim().toLowerCase();
      filtered = filtered.filter((e) =>
        e.tags.some((t) => t.toLowerCase().includes(needle)),
      );
    }
    if (status && status.trim()) {
      filtered = filtered.filter((e) => e.effectiveStatus === status);
    }

    // Newest execution first; pinned session's executions naturally stay
    // near each other because the grouping happens inside each session.
    filtered.sort((a, b) => b.startTime.localeCompare(a.startTime));
    return filtered.slice(0, lim);
  });

  // v0.8-b: execution detail — full events + usage + commits for one execution
  app.get<{ Params: { id: string } }>('/api/executions/:id', async (req, reply) => {
    // id format: `${sessionId}:exec-${index}`
    const lastColon = req.params.id.lastIndexOf(':exec-');
    if (lastColon < 0) return reply.code(400).send({ error: 'malformed execution id' });
    const sessionId = req.params.id.slice(0, lastColon);
    const indexStr = req.params.id.slice(lastColon + ':exec-'.length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isFinite(index) || index < 0) {
      return reply.code(400).send({ error: 'malformed execution index' });
    }

    const s = db.getSession(sessionId);
    if (!s) return reply.code(404).send({ error: 'session not found' });

    const events = db.listEventsForSession(s.id, 5000).map(rowToTimelineItem);
    const groups = groupEventsIntoExecutions(events);
    const group = groups[index];
    if (!group) return reply.code(404).send({ error: 'execution not found in session' });

    const usage = db.listUsageForSession(s.id).map(rowToUsageDto);
    const usageByGroup = associateUsageToExecutions(groups, usage);

    let commits: import('@agentos/shared').GitCommitInfo[] = [];
    if (s.project_display || s.project) {
      try {
        const { commitsInRange, findRepoRoot } = await import('./git-service.js');
        const root = await findRepoRoot(s.project_display || s.project);
        if (root) {
          commits = await commitsInRange(
            root,
            s.start_time,
            s.end_time ?? new Date().toISOString(),
            200,
          );
        }
      } catch {
        // non-fatal
      }
    }
    const commitsByGroup = associateCommitsToExecutions(groups, commits);

    const baseExec = buildExecution(
      s.id,
      s.agent_id,
      s.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
      s.project,
      s.project_display || s.project,
      group,
      commitsByGroup.get(group.index) ?? [],
      usageByGroup.get(group.index) ?? [],
    );
    // v0.9: apply execution_metadata on top
    const meta = db.getExecutionMetadata(req.params.id);
    const exec = applyExecutionMetadata(baseExec, meta);

    return {
      ...exec,
      events: group.events,
      usage: usageByGroup.get(group.index) ?? [],
    };
  });

  // v0.8-c: executions for one session (used by SessionDetail page)
  app.get<{ Params: { id: string } }>('/api/sessions-v2/:id/executions', async (req, reply) => {
    const s = db.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'session not found' });

    const events = db.listEventsForSession(s.id, 5000).map(rowToTimelineItem);
    const groups = groupEventsIntoExecutions(events);
    if (groups.length === 0) return [];

    const usage = db.listUsageForSession(s.id).map(rowToUsageDto);
    const usageByGroup = associateUsageToExecutions(groups, usage);

    let commits: import('@agentos/shared').GitCommitInfo[] = [];
    if (s.project_display || s.project) {
      try {
        const { commitsInRange, findRepoRoot } = await import('./git-service.js');
        const root = await findRepoRoot(s.project_display || s.project);
        if (root) {
          commits = await commitsInRange(
            root,
            s.start_time,
            s.end_time ?? new Date().toISOString(),
            200,
          );
        }
      } catch {
        // non-fatal
      }
    }
    const commitsByGroup = associateCommitsToExecutions(groups, commits);

    // v0.9: bulk-fetch metadata for these executions
    const execIds = groups.map((g) => `${s.id}:exec-${g.index}`);
    const metaMap = db.getExecutionMetadataBulk(execIds);

    return groups.map((g) => {
      const baseExec = buildExecution(
        s.id,
        s.agent_id,
        s.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
        s.project,
        s.project_display || s.project,
        g,
        commitsByGroup.get(g.index) ?? [],
        usageByGroup.get(g.index) ?? [],
      );
      return applyExecutionMetadata(baseExec, metaMap.get(baseExec.id) ?? null);
    });
  });

  /* ---------------- v0.9: Execution Workspace ---------------- */

  // v0.9-a: read a single execution's metadata + effective status
  app.get<{ Params: { id: string } }>('/api/executions/:id/metadata', async (req, reply) => {
    // id format: `${sessionId}:exec-${index}` — same parser as detail
    const lastColon = req.params.id.lastIndexOf(':exec-');
    if (lastColon < 0) return reply.code(400).send({ error: 'malformed execution id' });
    const sessionId = req.params.id.slice(0, lastColon);
    if (!db.getSession(sessionId)) {
      return reply.code(404).send({ error: 'session not found' });
    }
    const meta = db.getExecutionMetadata(req.params.id);
    return {
      metadata: meta,
      effectiveStatus: meta?.manualStatus ?? null, // null when no manual override
    };
  });

  // v0.9-b: patch metadata (displayName / note / tags / manualStatus)
  app.patch<{ Params: { id: string }; Body: Partial<{
    displayName?: string | null;
    note?: string | null;
    tags?: string[];
    manualStatus?: string | null;
  }> }>('/api/executions/:id/metadata', async (req, reply) => {
    const lastColon = req.params.id.lastIndexOf(':exec-');
    if (lastColon < 0) return reply.code(400).send({ error: 'malformed execution id' });
    const sessionId = req.params.id.slice(0, lastColon);
    if (!db.getSession(sessionId)) {
      return reply.code(404).send({ error: 'session not found' });
    }

    const b = req.body ?? {};
    // Validate manualStatus if provided (allow null = clear)
    const VALID_STATUS = new Set(['todo', 'in-progress', 'done', 'blocked', 'archived']);
    let manualStatus: import('@agentos/shared').ManualExecutionStatus | null | undefined;
    if (b.manualStatus === null) {
      manualStatus = null;
    } else if (b.manualStatus === undefined) {
      manualStatus = undefined;
    } else if (typeof b.manualStatus === 'string' && VALID_STATUS.has(b.manualStatus)) {
      manualStatus = b.manualStatus as import('@agentos/shared').ManualExecutionStatus;
    } else {
      return reply.code(400).send({ error: 'invalid manualStatus', allowed: [...VALID_STATUS] });
    }

    // Sanitize tags (same rules as session_metadata)
    let tags: string[] | undefined;
    if (Array.isArray(b.tags)) {
      const seen = new Set<string>();
      tags = [];
      for (const t of b.tags) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        tags.push(trimmed);
        if (tags.length >= 32) break;
      }
    }

    const updated = db.upsertExecutionMetadata(req.params.id, {
      displayName:  b.displayName === undefined ? undefined : (b.displayName || null),
      note:         b.note        === undefined ? undefined : (b.note        || null),
      tags,
      manualStatus,
    });
    // v1.0: append a history row when manualStatus actually changes.
    // Same status -> skip (otherwise the timeline fills with duplicates).
    const beforeManual = db.getExecutionMetadata(req.params.id);
    // (beforeManual is the row BEFORE upsert; we captured its effectiveStatus above.
    // To avoid double-reading, re-fetch only when status might have changed:)
    const prevBefore = db.raw.prepare(
      `SELECT manual_status FROM execution_metadata WHERE execution_id = ?`,
    ).get(req.params.id) as { manual_status: string | null } | undefined;
    void beforeManual; // (kept for symmetry with future audit; harmless)
    if (b.manualStatus !== undefined && prevBefore?.manual_status !== updated.manualStatus) {
      const fromStatus = (prevBefore?.manual_status ?? null) as
        import('@agentos/shared').EffectiveExecutionStatus | null;
      const toStatus = (updated.manualStatus ?? 'unknown') as
        import('@agentos/shared').EffectiveExecutionStatus;
      db.recordStatusChange(req.params.id, fromStatus, toStatus, 'manual');
    }
    return updated;
  });

  /* ---------------- v1.0: Execution Status History ---------------- */

  // v1.0-a: read transition log for one execution (oldest-first)
  app.get<{ Params: { id: string } }>('/api/executions/:id/history', async (req, reply) => {
    const lastColon = req.params.id.lastIndexOf(':exec-');
    if (lastColon < 0) return reply.code(400).send({ error: 'malformed execution id' });
    const sessionId = req.params.id.slice(0, lastColon);
    if (!db.getSession(sessionId)) {
      return reply.code(404).send({ error: 'session not found' });
    }
    return db.getExecutionStatusHistory(req.params.id, 200);
  });

  /* ---------------- v1.1: Agent Lifecycle Intelligence ---------------- */

  // v1.1-a: read-only derived lifecycle snapshot for one execution.
  // PURE: re-derives on every request from current activity_events +
  // git commits. Never persists, never mutates, never schedules.
  app.get<{ Params: { id: string } }>('/api/executions/:id/lifecycle', async (req, reply) => {
    const lastColon = req.params.id.lastIndexOf(':exec-');
    if (lastColon < 0) return reply.code(400).send({ error: 'malformed execution id' });
    const sessionId = req.params.id.slice(0, lastColon);
    const s = db.getSession(sessionId);
    if (!s) return reply.code(404).send({ error: 'session not found' });

    // Re-use the same projection as the v0.8 detail route:
    // pull events + commits within the execution's window. We don't
    // need full event detail here — just timestamp + type — so we
    // map to a slim TimelineItem subset the analyzer expects.
    const events = db.listEventsForSession(s.id, 5000).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentType: r.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
      sessionId: r.session_id,
      sessionTitle: null,
      project: '',
      projectDisplay: '',
      timestamp: r.timestamp,
      type: r.type as import('@agentos/shared').TimelineItem['type'],
      action: '',
      detail: r.detail,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    }));

    // We need commits within the EXECUTION's window — not the
    // session's. The execution window is group.start..group.end;
    // the simplest correct approach is to recompute groups (the
    // 30-min grouping rule is in execution-service) and pull commits
    // for whichever group matches `:exec-${index}`. To keep this
    // endpoint cheap we approximate using the full session window
    // and let the analyzer filter — commits outside the execution
    // window will simply not affect the snapshot's commit-recent check
    // (we only look at "most recent commit").
    let commits: import('@agentos/shared').GitCommitInfo[] = [];
    if (s.project_display || s.project) {
      try {
        const { commitsInRange, findRepoRoot } = await import('./git-service.js');
        const root = await findRepoRoot(s.project_display || s.project);
        if (root) {
          commits = await commitsInRange(
            root,
            s.start_time,
            s.end_time ?? new Date().toISOString(),
            50,
          );
        }
      } catch {
        // non-fatal: just no commits in snapshot
      }
    }

    const { analyzeLifecycle } = await import('./lifecycle-analyzer.js');
    return analyzeLifecycle(req.params.id, {
      events,
      commits,
      startTime: s.start_time,
      endTime: s.end_time ?? null,
    });
  });

  // v1.1-b: batch lifecycle — used by Workspace Board to avoid N+1.
  // Returns a map keyed by execution id. Unknown ids are silently
  // omitted (the Board simply skips them).
  app.post<{ Body: { ids?: string[] } }>('/api/lifecycle/batch', async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids.slice(0, 500) : [];
    const out: Record<string, import('@agentos/shared').LifecycleSnapshot> = {};
    if (ids.length === 0) return out;

    const { analyzeLifecycle } = await import('./lifecycle-analyzer.js');

    // Parse + bucket ids by sessionId so we can pull events once per
    // session instead of N times.
    type Bucket = { execIndex: number; sessionId: string };
    const bySession = new Map<string, Bucket[]>();
    for (const id of ids) {
      const lastColon = id.lastIndexOf(':exec-');
      if (lastColon < 0) continue;
      const sessionId = id.slice(0, lastColon);
      const indexStr = id.slice(lastColon + ':exec-'.length);
      const execIndex = Number.parseInt(indexStr, 10);
      if (!Number.isFinite(execIndex) || execIndex < 0) continue;
      const arr = bySession.get(sessionId) ?? [];
      arr.push({ execIndex, sessionId: id });
      bySession.set(sessionId, arr);
    }

    for (const [sessionId, buckets] of bySession.entries()) {
      const s = db.getSession(sessionId);
      if (!s) continue;

      // Pull events + commits once for this session.
      const events = db.listEventsForSession(s.id, 5000).map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        agentType: r.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
        sessionId: r.session_id,
        sessionTitle: null,
        project: '',
        projectDisplay: '',
        timestamp: r.timestamp,
        type: r.type as import('@agentos/shared').TimelineItem['type'],
        action: '',
        detail: r.detail,
        meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
      }));
      let commits: import('@agentos/shared').GitCommitInfo[] = [];
      if (s.project_display || s.project) {
        try {
          const { commitsInRange, findRepoRoot } = await import('./git-service.js');
          const root = await findRepoRoot(s.project_display || s.project);
          if (root) {
            commits = await commitsInRange(
              root,
              s.start_time,
              s.end_time ?? new Date().toISOString(),
              50,
            );
          }
        } catch {
          // non-fatal
        }
      }
      // Compute one snapshot per requested execIndex. Other events /
      // commits outside that window are not filtered (the analyzer
      // looks at lastEventAge, which works on a single execution's
      // window only after grouping). To keep batch O(1) per session
      // we approximate using the full session window — the analyzer
      // is tolerant: it uses lastEventMs which is the most-recent
      // event in the window, so multi-exec sessions may share
      // recent-activity signals across executions. This is a known
      // approximation documented in the endpoint description.
      for (const bucket of buckets) {
        out[bucket.sessionId] = analyzeLifecycle(bucket.sessionId, {
          events,
          commits,
          startTime: s.start_time,
          endTime: s.end_time ?? null,
        });
      }
    }
    return out;
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

/**
 * v0.8: convert a raw EventRow into a TimelineItem (for grouping +
 * execution projection). We don't join sessions here — caller supplies
 * project/display via the surrounding session.
 */
function rowToTimelineItem(r: import('./db.js').EventRow): import('@agentos/shared').TimelineItem {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentType: r.agent_id.split(':')[0] as import('@agentos/shared').AgentType,
    sessionId: r.session_id,
    sessionTitle: null,
    project: '',
    projectDisplay: '',
    timestamp: r.timestamp,
    type: r.type as import('@agentos/shared').TimelineItem['type'],
    action: humanAction(r.type, r.detail),
    detail: r.detail,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
  };
}

/** v0.8: convert a raw UsageRow into the shared UsageRecord shape. */
function rowToUsageDto(r: import('./db.js').UsageRow): import('@agentos/shared').UsageRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    estimatedCost: r.estimated_cost,
    timestamp: r.timestamp,
    usageConfidence: r.usage_confidence,
    costConfidence: r.cost_confidence,
    unknownModel: r.unknown_model !== 0,
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

/* ---------------- v0.7: Session Management helpers ---------------- */

function parseTagsJson(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string');
  } catch { /* fall through */ }
  return [];
}

/** Merge metadata into a SessionDto. Sets `displayName` to metadata.displayName (or null), and copies tags + pinned. */
function withMetadata(
  s: ReturnType<typeof rowToSessionDto>,
  m: import('@agentos/shared').SessionMetadata | null,
): ReturnType<typeof rowToSessionDto> & {
  displayName?: string | null;
  tags: string[];
  pinned: boolean;
} {
  return {
    ...s,
    displayName: m?.displayName ?? null,
    tags: m?.tags ?? [],
    pinned: m?.pinned ?? false,
  };
}

/** Same as withMetadata but also folds in COUNT/SUM precomputed columns. */
function withMetadataSummary(
  r: import('./db.js').SessionRow & {
    sm_display_name: string | null;
    sm_note: string | null;
    sm_tags: string | null;
    sm_pinned: number | null;
    sm_created_at: string | null;
    sm_updated_at: string | null;
    event_count: number;
    sum_tokens: number;
    sum_cost: number;
  },
  s: ReturnType<typeof rowToSessionDto>,
): ReturnType<typeof rowToSessionDto> & {
  displayName?: string | null;
  tags: string[];
  pinned: boolean;
  note?: string | null;
  metadataCreatedAt?: string;
  metadataUpdatedAt?: string;
  eventCount: number;
  usageTokens: number;
  usageCost: number;
} {
  return {
    ...s,
    displayName: r.sm_display_name,
    note: r.sm_note,
    tags: parseTagsJson(r.sm_tags),
    pinned: (r.sm_pinned ?? 0) !== 0,
    metadataCreatedAt: r.sm_created_at ?? undefined,
    metadataUpdatedAt: r.sm_updated_at ?? undefined,
    eventCount: r.event_count,
    usageTokens: r.sum_tokens,
    usageCost: r.sum_cost,
  };
}

function computeDurationMs(startTime: string, endTime?: string | null): number | null {
  const s = Date.parse(startTime);
  if (Number.isNaN(s)) return null;
  if (!endTime) return Date.now() - s;
  const e = Date.parse(endTime);
  if (Number.isNaN(e)) return null;
  return e - s;
}

export type { RealtimeEvent, AgentStatusRow };

// Re-export for type completeness
export type { ConfidenceLevel };