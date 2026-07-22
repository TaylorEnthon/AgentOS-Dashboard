/**
 * Derive agent runtime status from `activity_events` — no schema change.
 *
 * Rule (per v0.4 spec):
 *   - <  ACTIVE_THRESHOLD_S  since last activity → 'active'
 *   - <  IDLE_THRESHOLD_S    since last activity → 'idle'
 *   - else / no events       → 'unknown'
 *
 * The two thresholds are separated so we can tune "active" tight
 * without making "idle" jump straight to "unknown".
 */
import type Database from 'better-sqlite3';

export const ACTIVE_THRESHOLD_S = 30;
export const IDLE_THRESHOLD_S = 5 * 60; // 5 minutes

export type AgentStatus = 'active' | 'idle' | 'unknown';

export interface AgentStatusRow {
  agent: string;
  status: AgentStatus;
  lastActivity?: string;
  lastProject?: string;
  lastAction?: string;
  lastEventType?: string;
}

interface LatestEventRow {
  agent_id: string;
  ts: string;
  type: string;
  detail: string | null;
  session_id: string;
  project: string;
}

export function deriveAgentStatus(
  raw: Database.Database,
  now: Date = new Date(),
): AgentStatusRow[] {
  const nowMs = now.getTime();
  const activeCutoffMs = nowMs - ACTIVE_THRESHOLD_S * 1000;
  const idleCutoffMs = nowMs - IDLE_THRESHOLD_S * 1000;

  // For every known agent, find its single most recent activity_event.
  // We join on sessions to also pull the project.
  const rows = raw.prepare(
    `SELECT
       a.id           AS agent,
       a.type         AS agent_type,
       a.name         AS agent_name,
       a.data_dir     AS data_dir,
       a.enabled      AS enabled,
       a.last_scanned_at AS last_scanned_at,
       e.timestamp    AS ev_ts,
       e.type         AS ev_type,
       e.detail       AS ev_detail,
       e.session_id   AS ev_session_id,
       s.project      AS ev_project
     FROM agents a
     LEFT JOIN (
       SELECT agent_id, timestamp, type, detail, session_id
       FROM (
         SELECT agent_id, timestamp, type, detail, session_id,
                ROW_NUMBER() OVER (
                  PARTITION BY agent_id ORDER BY timestamp DESC
                ) AS rn
         FROM activity_events
       ) WHERE rn = 1
     ) e ON e.agent_id = a.id
     LEFT JOIN sessions s ON s.id = e.session_id
     ORDER BY a.name`,
  ).all() as Array<{
    agent: string;
    agent_type: string;
    agent_name: string;
    data_dir: string;
    enabled: number;
    last_scanned_at: string | null;
    ev_ts: string | null;
    ev_type: string | null;
    ev_detail: string | null;
    ev_session_id: string | null;
    ev_project: string | null;
  }>;

  const out: AgentStatusRow[] = [];
  for (const r of rows) {
    let status: AgentStatus = 'unknown';
    if (r.enabled === 0) {
      status = 'unknown';
    } else if (r.ev_ts) {
      const t = Date.parse(r.ev_ts);
      if (Number.isFinite(t)) {
        if (t >= activeCutoffMs) status = 'active';
        else if (t >= idleCutoffMs) status = 'idle';
        else status = 'unknown';
      }
    }
    out.push({
      agent: r.agent,
      status,
      lastActivity: r.ev_ts ?? undefined,
      lastProject: r.ev_project ?? undefined,
      lastAction: r.ev_detail ?? r.ev_type ?? undefined,
      lastEventType: r.ev_type ?? undefined,
    });
  }
  return out;
}