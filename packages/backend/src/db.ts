import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  AgentSession,
  AgentType,
  ActivityEvent,
  Project,
  UsageRecord,
} from '@agentos/shared';

export interface AgentRow {
  id: string;
  name: string;
  type: AgentType;
  data_dir: string;
  enabled: number;
  capabilities: string | null;
  last_scanned_at: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  external_id: string;
  project: string;
  project_display: string;
  title: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
  model: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  file_ops: number;
  tool_calls: number;
}

export interface UsageRow {
  id: string;
  session_id: string;
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  timestamp: string;
}

export interface EventRow {
  id: string;
  session_id: string;
  agent_id: string;
  type: string;
  timestamp: string;
  detail: string | null;
  meta: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data_dir TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  project TEXT NOT NULL,
  project_display TEXT,
  title TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  status TEXT NOT NULL,
  model TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  file_ops INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL,
  estimated_cost REAL NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  detail TEXT,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  display_name TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent   ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_start   ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_usage_session    ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts         ON usage_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_session   ON activity_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON activity_events(timestamp);
`;

export class Db {
  readonly raw: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
  }

  // ---------------- Agents ----------------
  upsertAgent(a: {
    id: string;
    name: string;
    type: AgentType;
    dataDir: string;
    enabled: boolean;
    capabilities?: string[];
  }): void {
    const stmt = this.raw.prepare(
      `INSERT INTO agents (id, name, type, data_dir, enabled, capabilities, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         data_dir = excluded.data_dir,
         enabled = excluded.enabled,
         capabilities = excluded.capabilities`,
    );
    stmt.run(
      a.id,
      a.name,
      a.type,
      a.dataDir,
      a.enabled ? 1 : 0,
      a.capabilities ? JSON.stringify(a.capabilities) : null,
      new Date().toISOString(),
    );
  }

  setAgentScanned(id: string, ts: string): void {
    this.raw.prepare(`UPDATE agents SET last_scanned_at = ? WHERE id = ?`).run(ts, id);
  }

  setAgentEnabled(id: string, enabled: boolean): void {
    this.raw.prepare(`UPDATE agents SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }

  listAgents(): AgentRow[] {
    return this.raw.prepare(`SELECT * FROM agents ORDER BY name`).all() as AgentRow[];
  }

  getAgent(id: string): AgentRow | undefined {
    return this.raw.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
  }

  // ---------------- Sessions ----------------
  upsertSession(s: AgentSession): void {
    const stmt = this.raw.prepare(
      `INSERT INTO sessions (
         id, agent_id, external_id, project, project_display, title,
         start_time, end_time, status, model,
         message_count, total_input_tokens, total_output_tokens, total_tokens,
         estimated_cost, file_ops, tool_calls
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         end_time = COALESCE(excluded.end_time, sessions.end_time),
         status = excluded.status,
         model = COALESCE(excluded.model, sessions.model),
         message_count = excluded.message_count,
         total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens,
         total_tokens = excluded.total_tokens,
         estimated_cost = excluded.estimated_cost,
         file_ops = excluded.file_ops,
         tool_calls = excluded.tool_calls`,
    );
    stmt.run(
      s.id, s.agentId, s.externalId, s.project, s.projectDisplay, s.title ?? null,
      s.startTime, s.endTime ?? null, s.status, s.model ?? null,
      s.messageCount, s.totalInputTokens, s.totalOutputTokens, s.totalTokens,
      s.estimatedCost, s.fileOps, s.toolCalls,
    );
  }

  listSessions(opts: { agentId?: string; project?: string; limit?: number; status?: string } = {}): SessionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.agentId) { where.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.project) { where.push('project = ?'); params.push(opts.project); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM sessions ${whereSql} ORDER BY start_time DESC LIMIT ${limit}`;
    return this.raw.prepare(sql).all(...params) as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.raw.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  // ---------------- Usage ----------------
  insertUsage(u: UsageRecord): void {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO usage_records (
         id, session_id, agent_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_tokens, estimated_cost, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      u.id, u.sessionId, u.agentId, u.model,
      u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0,
      u.totalTokens, u.estimatedCost, u.timestamp,
    );
  }

  listUsageForSession(sessionId: string): UsageRow[] {
    return this.raw.prepare(
      `SELECT * FROM usage_records WHERE session_id = ? ORDER BY timestamp ASC`,
    ).all(sessionId) as UsageRow[];
  }

  // ---------------- Events ----------------
  insertEvent(e: ActivityEvent): void {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO activity_events (
         id, session_id, agent_id, type, timestamp, detail, meta
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      e.id, e.sessionId, e.agentId, e.type, e.timestamp,
      e.detail ?? null, e.meta ? JSON.stringify(e.meta) : null,
    );
  }

  listEventsForSession(sessionId: string, limit = 500): EventRow[] {
    return this.raw.prepare(
      `SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`,
    ).all(sessionId, limit) as EventRow[];
  }

  // ---------------- Projects ----------------
  upsertProject(p: { path: string; displayName: string; lastSeen: string }): void {
    this.raw.prepare(
      `INSERT INTO projects (path, display_name, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         display_name = excluded.display_name,
         last_seen = excluded.last_seen`,
    ).run(p.path, p.displayName, p.lastSeen);
  }

  listProjects(): Project[] {
    const rows = this.raw.prepare(`SELECT * FROM projects ORDER BY display_name`).all() as Array<{
      path: string; display_name: string; last_seen: string | null;
    }>;
    return rows.map((r) => {
      const stats = this.raw.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(total_tokens), 0) AS t, COALESCE(SUM(estimated_cost), 0) AS cost
         FROM sessions WHERE project = ?`,
      ).get(r.path) as { c: number; t: number; cost: number };
      const agentRows = this.raw.prepare(
        `SELECT DISTINCT agent_id FROM sessions WHERE project = ?`,
      ).all(r.path) as Array<{ agent_id: string }>;
      return {
        path: r.path,
        displayName: r.display_name,
        agents: agentRows.map((a) => a.agent_id) as AgentType[],
        sessionCount: stats.c,
        totalTokens: stats.t,
        totalCost: stats.cost,
        lastActivity: r.last_seen ?? undefined,
      };
    });
  }

  // ---------------- Aggregates ----------------
  overview(): {
    totalSessions: number;
    activeSessions: number;
    totalTokens: number;
    totalCost: number;
    todayTokens: number;
    todayCost: number;
    todaySessions: number;
    byAgent: Array<{
      agentId: string;
      sessions: number;
      tokens: number;
      cost: number;
    }>;
    daily: Array<{ date: string; tokens: number; cost: number; sessions: number }>;
  } {
    const today = new Date().toISOString().slice(0, 10);
    const totals = this.raw.prepare(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(total_tokens), 0) AS t,
              COALESCE(SUM(estimated_cost), 0) AS cost
       FROM sessions`,
    ).get() as { c: number; t: number; cost: number };

    const active = (this.raw.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE status = 'running'`,
    ).get() as { c: number }).c;

    const todayRow = this.raw.prepare(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(total_tokens), 0) AS t,
              COALESCE(SUM(estimated_cost), 0) AS cost
       FROM sessions WHERE substr(start_time, 1, 10) = ?`,
    ).get(today) as { c: number; t: number; cost: number };

    const byAgent = this.raw.prepare(
      `SELECT agent_id AS agentId,
              COUNT(*) AS sessions,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(estimated_cost), 0) AS cost
       FROM sessions GROUP BY agent_id`,
    ).all() as Array<{ agentId: string; sessions: number; tokens: number; cost: number }>;

    const daily = this.raw.prepare(
      `SELECT substr(start_time, 1, 10) AS date,
              COUNT(*) AS sessions,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(estimated_cost), 0) AS cost
       FROM sessions
       WHERE start_time >= date('now', '-13 days')
       GROUP BY substr(start_time, 1, 10)
       ORDER BY date ASC`,
    ).all() as Array<{ date: string; sessions: number; tokens: number; cost: number }>;

    return {
      totalSessions: totals.c,
      activeSessions: active,
      totalTokens: totals.t,
      totalCost: totals.cost,
      todaySessions: todayRow.c,
      todayTokens: todayRow.t,
      todayCost: todayRow.cost,
      byAgent,
      daily,
    };
  }

  // ---------------- Settings ----------------
  getSetting(key: string): string | undefined {
    return (this.raw.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.raw.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  deleteSetting(key: string): void {
    this.raw.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.raw.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  close(): void { this.raw.close(); }
}