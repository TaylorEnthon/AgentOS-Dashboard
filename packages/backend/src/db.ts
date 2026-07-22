import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  AgentSession,
  AgentType,
  ActivityEvent,
  Project,
  UsageRecord,
  DataHealth,
  ConfidenceLevel,
  SourceMeta,
  TimelineItem,
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
  usage_confidence: ConfidenceLevel | null;
  cost_confidence: ConfidenceLevel | null;
  source_file: string | null;
  source_id: string | null;
  collected_at: string | null;
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
  usage_confidence: ConfidenceLevel;
  cost_confidence: ConfidenceLevel;
  unknown_model: number; // 0 | 1
  source_file: string | null;
  source_id: string | null;
  collected_at: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  agent_id: string;
  type: string;
  timestamp: string;
  detail: string | null;
  meta: string | null;
  source_file: string | null;
  source_id: string | null;
  collected_at: string | null;
}

export interface IngestionFileRow {
  id: string;            // sha256(provider + file_path)
  provider: AgentType;
  file_path: string;
  size: number;
  mtime_ms: number;
  content_hash: string;
  last_scanned_at: string;
  sessions: number;
  usage_records: number;
  events: number;
  /** Running counter of usage rows that were skipped due to PK collision. */
  duplicates_prevented: number;
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
  usage_confidence TEXT,
  cost_confidence TEXT,
  source_file TEXT,
  source_id TEXT,
  collected_at TEXT,
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
  timestamp TEXT NOT NULL,
  usage_confidence TEXT NOT NULL DEFAULT 'unknown',
  cost_confidence TEXT NOT NULL DEFAULT 'unknown',
  unknown_model INTEGER NOT NULL DEFAULT 0,
  source_file TEXT,
  source_id TEXT,
  collected_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  detail TEXT,
  meta TEXT,
  source_file TEXT,
  source_id TEXT,
  collected_at TEXT
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

CREATE TABLE IF NOT EXISTS ingestion_files (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  usage_records INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  duplicates_prevented INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, file_path)
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent   ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_start   ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_usage_session    ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts         ON usage_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_cost_conf  ON usage_records(cost_confidence);
CREATE INDEX IF NOT EXISTS idx_usage_usage_conf ON usage_records(usage_confidence);
CREATE INDEX IF NOT EXISTS idx_events_session   ON activity_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON activity_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_ingest_provider  ON ingestion_files(provider);
`;

const CURRENT_SCHEMA_VERSION = '0.2.0';

export class Db {
  readonly raw: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent migration: ALTER TABLE add columns introduced in v0.2. */
  private migrate(): void {
    const row = this.raw.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    const current = row?.value ?? '0.0.0';
    if (current === CURRENT_SCHEMA_VERSION) return;

    const hasColumn = (table: string, col: string): boolean => {
      const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === col);
    };

    const addCol = (table: string, col: string, decl: string) => {
      if (!hasColumn(table, col)) {
        this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      }
    };

    // v0.2 additions
    addCol('sessions', 'usage_confidence', "TEXT");
    addCol('sessions', 'cost_confidence', "TEXT");
    addCol('sessions', 'source_file', "TEXT");
    addCol('sessions', 'source_id', "TEXT");
    addCol('sessions', 'collected_at', "TEXT");

    addCol('usage_records', 'usage_confidence', "TEXT NOT NULL DEFAULT 'unknown'");
    addCol('usage_records', 'cost_confidence', "TEXT NOT NULL DEFAULT 'unknown'");
    addCol('usage_records', 'unknown_model', "INTEGER NOT NULL DEFAULT 0");
    addCol('usage_records', 'source_file', "TEXT");
    addCol('usage_records', 'source_id', "TEXT");
    addCol('usage_records', 'collected_at', "TEXT");

    addCol('activity_events', 'source_file', "TEXT");
    addCol('activity_events', 'source_id', "TEXT");
    addCol('activity_events', 'collected_at', "TEXT");

    // Backfill: pre-v0.2 rows should be flagged 'unknown'
    this.raw.exec(`UPDATE sessions SET usage_confidence = COALESCE(usage_confidence, 'unknown')`);
    this.raw.exec(`UPDATE sessions SET cost_confidence  = COALESCE(cost_confidence, 'unknown')`);

    this.raw.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(CURRENT_SCHEMA_VERSION);
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
      a.id, a.name, a.type, a.dataDir,
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
         estimated_cost, file_ops, tool_calls,
         usage_confidence, cost_confidence,
         source_file, source_id, collected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         tool_calls = excluded.tool_calls,
         usage_confidence = COALESCE(excluded.usage_confidence, sessions.usage_confidence),
         cost_confidence  = COALESCE(excluded.cost_confidence,  sessions.cost_confidence),
         source_file = COALESCE(excluded.source_file, sessions.source_file),
         source_id   = COALESCE(excluded.source_id,   sessions.source_id),
         collected_at = COALESCE(excluded.collected_at, sessions.collected_at)`,
    );
    stmt.run(
      s.id, s.agentId, s.externalId, s.project, s.projectDisplay, s.title ?? null,
      s.startTime, s.endTime ?? null, s.status, s.model ?? null,
      s.messageCount, s.totalInputTokens, s.totalOutputTokens, s.totalTokens,
      s.estimatedCost, s.fileOps, s.toolCalls,
      s.usageConfidence ?? null, s.costConfidence ?? null,
      s.source?.sourceFile ?? null,
      s.source?.sourceId ?? null,
      s.source?.collectedAt ?? null,
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
  /**
   * INSERT OR IGNORE — returns true if a new row was inserted, false if
   * the primary key collided (i.e. dedup prevented a duplicate).
   */
  insertUsage(u: UsageRecord): boolean {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO usage_records (
         id, session_id, agent_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_tokens, estimated_cost, timestamp,
         usage_confidence, cost_confidence, unknown_model,
         source_file, source_id, collected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const r = stmt.run(
      u.id, u.sessionId, u.agentId, u.model,
      u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0,
      u.totalTokens, u.estimatedCost, u.timestamp,
      u.usageConfidence, u.costConfidence, u.unknownModel ? 1 : 0,
      u.source?.sourceFile ?? null,
      u.source?.sourceId ?? null,
      u.source?.collectedAt ?? null,
    );
    return r.changes === 1;
  }

  listUsageForSession(sessionId: string): UsageRow[] {
    return this.raw.prepare(
      `SELECT * FROM usage_records WHERE session_id = ? ORDER BY timestamp ASC`,
    ).all(sessionId) as UsageRow[];
  }

  // ---------------- Events ----------------
  /** Same as insertUsage: returns true iff a new row was inserted. */
  insertEvent(e: ActivityEvent): boolean {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO activity_events (
         id, session_id, agent_id, type, timestamp, detail, meta,
         source_file, source_id, collected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const r = stmt.run(
      e.id, e.sessionId, e.agentId, e.type, e.timestamp,
      e.detail ?? null, e.meta ? JSON.stringify(e.meta) : null,
      e.source?.sourceFile ?? null,
      e.source?.sourceId ?? null,
      e.source?.collectedAt ?? null,
    );
    return r.changes === 1;
  }

  listEventsForSession(sessionId: string, limit = 500): EventRow[] {
    return this.raw.prepare(
      `SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`,
    ).all(sessionId, limit) as EventRow[];
  }

  /**
   * v0.5 timeline projection: `activity_events ⨝ sessions`, optionally
   * filtered. Always ordered newest-first so the UI's "scroll to bottom
   * for oldest" stays natural.
   */
  listTimeline(opts: {
    agentId?: string;
    project?: string;
    sessionId?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}): TimelineItem[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.agentId) { where.push('e.agent_id = ?'); params.push(opts.agentId); }
    if (opts.sessionId) { where.push('e.session_id = ?'); params.push(opts.sessionId); }
    if (opts.project) { where.push('s.project = ?'); params.push(opts.project); }
    if (opts.from) { where.push('e.timestamp >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('e.timestamp <= ?'); params.push(opts.to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.raw.prepare(
      `SELECT
         e.id            AS id,
         e.agent_id      AS agent_id,
         e.session_id    AS session_id,
         s.title         AS session_title,
         s.project       AS project,
         s.project_display AS project_display,
         e.timestamp     AS timestamp,
         e.type          AS type,
         e.detail        AS detail,
         e.meta          AS meta
       FROM activity_events e
       LEFT JOIN sessions s ON s.id = e.session_id
       ${whereSql}
       ORDER BY e.timestamp DESC
       LIMIT ${limit}`,
    ).all(...params) as Array<{
      id: string;
      agent_id: string;
      session_id: string;
      session_title: string | null;
      project: string | null;
      project_display: string | null;
      timestamp: string;
      type: string;
      detail: string | null;
      meta: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentType: r.agent_id.split(':')[0] as AgentType,
      sessionId: r.session_id,
      sessionTitle: r.session_title,
      project: r.project ?? '',
      projectDisplay: r.project_display ?? r.project ?? '',
      timestamp: r.timestamp,
      type: r.type as TimelineItem['type'],
      action: humanAction(r.type, r.detail),
      detail: r.detail,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    }));
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

  // ---------------- Ingestion files ----------------
  /**
   * Upsert an ingestion_files row. `duplicatesPrevented` is the per-file
   * dedup count for the MOST RECENT scan of this file — it overwrites
   * (does not accumulate). The cumulative total across all scans lives
   * in the `totalDuplicatesPrevented` setting; see {@link bumpTotalDuplicates}.
   */
  recordIngestionFile(args: {
    provider: AgentType;
    filePath: string;
    size: number;
    mtimeMs: number;
    contentHash: string;
    inserted: number;
    duplicatesPrevented: number;
    sessions: number;
    usageRecords: number;
    events: number;
  }): void {
    const id = args.provider + ':' + args.filePath;
    this.raw.prepare(
      `INSERT INTO ingestion_files (
         id, provider, file_path, size, mtime_ms, content_hash, last_scanned_at,
         sessions, usage_records, events, duplicates_prevented
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, file_path) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         content_hash = excluded.content_hash,
         last_scanned_at = excluded.last_scanned_at,
         sessions = excluded.sessions,
         usage_records = excluded.usage_records,
         events = excluded.events,
         duplicates_prevented = excluded.duplicates_prevented`,
    ).run(
      id, args.provider, args.filePath,
      args.size, args.mtimeMs, args.contentHash,
      new Date().toISOString(),
      args.sessions, args.usageRecords, args.events,
      args.duplicatesPrevented,
    );
  }

  /** Increment the global cumulative dedup counter. */
  bumpTotalDuplicates(delta: number): void {
    const cur = Number(this.getSetting('totalDuplicatesPrevented') ?? '0');
    this.setSetting('totalDuplicatesPrevented', String(Math.max(0, cur + delta)));
  }

  /** Read the global cumulative dedup counter. */
  getTotalDuplicates(): number {
    return Number(this.getSetting('totalDuplicatesPrevented') ?? '0');
  }

  listIngestionFiles(provider?: AgentType): IngestionFileRow[] {
    const sql = provider
      ? `SELECT * FROM ingestion_files WHERE provider = ? ORDER BY last_scanned_at DESC`
      : `SELECT * FROM ingestion_files ORDER BY last_scanned_at DESC`;
    return this.raw.prepare(sql).all(...(provider ? [provider] : [])) as IngestionFileRow[];
  }

  /** Prior fingerprint map for one agent — fed to collectors in incremental mode. */
  priorFileMap(provider: AgentType): Map<string, { size: number; mtimeMs: number; contentHash: string }> {
    const rows = this.raw.prepare(
      `SELECT file_path, size, mtime_ms, content_hash FROM ingestion_files WHERE provider = ?`,
    ).all(provider) as Array<{ file_path: string; size: number; mtime_ms: number; content_hash: string }>;
    return new Map(rows.map((r) => [r.file_path, {
      size: r.size, mtimeMs: r.mtime_ms, contentHash: r.content_hash,
    }]));
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

  /** v0.2 trust/provenance summary. */
  dataHealth(): DataHealth {
    const totalSessions = (this.raw.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
    const totalUsageRecords = (this.raw.prepare(`SELECT COUNT(*) AS c FROM usage_records`).get() as { c: number }).c;
    const totalEvents = (this.raw.prepare(`SELECT COUNT(*) AS c FROM activity_events`).get() as { c: number }).c;

    const usageRows = this.raw.prepare(
      `SELECT usage_confidence AS conf, COUNT(*) AS c FROM usage_records GROUP BY usage_confidence`,
    ).all() as Array<{ conf: string | null; c: number }>;
    const costRows = this.raw.prepare(
      `SELECT cost_confidence AS conf, COUNT(*) AS c FROM usage_records GROUP BY cost_confidence`,
    ).all() as Array<{ conf: string | null; c: number }>;
    const countBy = (rows: Array<{ conf: string | null; c: number }>): { exact: number; estimated: number; unknown: number } => {
      const out = { exact: 0, estimated: 0, unknown: 0 };
      for (const r of rows) {
        const k = (r.conf ?? 'unknown') as ConfidenceLevel;
        if (k === 'exact' || k === 'estimated' || k === 'unknown') out[k] += r.c;
        else out.unknown += r.c;
      }
      return out;
    };
    const usage = countBy(usageRows);
    const cost = countBy(costRows);

    const dupRow = this.raw.prepare(
      `SELECT COALESCE(SUM(duplicates_prevented), 0) AS d FROM ingestion_files`,
    ).get() as { d: number };
    const duplicatesPrevented = Number(this.getSetting('totalDuplicatesPrevented') ?? dupRow.d);

    const lastScanRow = this.raw.prepare(
      `SELECT MAX(last_scanned_at) AS ts FROM agents`,
    ).get() as { ts: string | null };

    const fileCount = (this.raw.prepare(`SELECT COUNT(*) AS c FROM ingestion_files`).get() as { c: number }).c;
    const fileSize = (this.raw.prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM ingestion_files`).get() as { s: number }).s;

    const perAgentRaw = this.raw.prepare(
      `SELECT a.id AS agent_id, a.last_scanned_at,
              (SELECT COUNT(*) FROM ingestion_files WHERE provider = a.type) AS files,
              (SELECT COALESCE(SUM(sessions), 0) FROM ingestion_files WHERE provider = a.type) AS sessions,
              (SELECT COALESCE(SUM(usage_records), 0) FROM ingestion_files WHERE provider = a.type) AS usage
       FROM agents a`,
    ).all() as Array<{ agent_id: string; last_scanned_at: string | null; files: number; sessions: number; usage: number }>;

    return {
      totalSessions,
      totalUsageRecords,
      totalEvents,
      usage,
      cost,
      duplicatesPrevented,
      lastScanAt: lastScanRow.ts ?? undefined,
      ingestionFiles: fileCount,
      ingestionFileSize: fileSize,
      perAgent: perAgentRaw.map((r) => ({
        agentId: r.agent_id,
        lastScanAt: r.last_scanned_at ?? undefined,
        files: r.files,
        sessions: r.sessions,
        usage: r.usage,
        duplicates: 0, // per-file dedup is not aggregated; use the cumulative `duplicatesPrevented` field
      })),
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

// Re-export for convenience
export type { SourceMeta };

/**
 * Format an activity_events row as a short human-readable action line
 * for the Timeline UI. Centralized so the same wording is used in
 * timeline rows, agent status rows, and anywhere else we surface events.
 */
export function humanAction(type: string, detail: string | null): string {
  if (detail && detail.trim().length > 0) {
    return `${typeLabel(type)} · ${detail.length > 160 ? detail.slice(0, 157) + '…' : detail}`;
  }
  return typeLabel(type);
}

function typeLabel(type: string): string {
  switch (type) {
    case 'session-start': return 'Session started';
    case 'session-end':   return 'Session ended';
    case 'message':        return 'Message';
    case 'tool-call':      return 'Tool call';
    case 'file-read':      return 'Read file';
    case 'file-write':     return 'Write file';
    case 'file-edit':      return 'Edit file';
    case 'command':        return 'Run command';
    case 'git-commit':     return 'Git commit';
    case 'status':         return 'Status';
    default:               return type;
  }
}