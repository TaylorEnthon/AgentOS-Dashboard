/**
 * v1.5 Health History Repository — pure SQL wrapper.
 *
 * Single source of truth for reading / writing persistent
 * `execution_health_history` and `execution_attention_history` rows.
 * The high-level `HealthHistoryStore` / `AttentionHistoryStore` in
 * `health-history.ts` delegate to this repository.
 *
 * No business logic lives here — just SQL and JSON encode/decode.
 * No scheduler / daemon / background worker; retention cleanup is
 * invoked explicitly (server startup, or after a write).
 */

import type {
  AttentionLifecycleState,
  HealthFactor,
  HealthLevel,
} from '@agentos/shared';
import type { Db } from './db.js';

/* ---------------- row types ---------------- */

export interface HealthHistoryRow {
  id: number;
  execution_id: string;
  score: number;
  level: HealthLevel;
  derived_status: string;
  factors_json: string;
  created_at: string;
}

export interface AttentionHistoryRow {
  id: number;
  execution_id: string;
  attention_key: string;
  lifecycle_state: AttentionLifecycleState;
  severity: string;
  reason: string;
  created_at: string;
}

/* ---------------- Health History repo ---------------- */

export class HealthHistoryRepository {
  constructor(private readonly db: Db) {}

  /**
   * Append one health snapshot. Caller is responsible for dedup
   * (use HealthHistoryStore.shouldRecord first).
   */
  insertHealth(args: {
    executionId: string;
    score: number;
    level: HealthLevel;
    derivedStatus: string;
    factors: HealthFactor[];
    nowIso: string;
  }): void {
    this.db.raw.prepare(
      `INSERT INTO execution_health_history
         (execution_id, score, level, derived_status, factors_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.executionId,
      args.score,
      args.level,
      args.derivedStatus,
      JSON.stringify(args.factors),
      args.nowIso,
    );
  }

  /** Latest health snapshot for an execution (highest id), or null. */
  getLatestHealth(executionId: string): HealthHistoryRow | null {
    const row = this.db.raw.prepare(
      `SELECT * FROM execution_health_history
       WHERE execution_id = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(executionId) as HealthHistoryRow | undefined;
    return row ?? null;
  }

  /**
   * Read up to `limit` snapshots for an execution, oldest-first
   * (so callers can hand them straight to analyzeHealthTrend).
   */
  readHealth(executionId: string, limit: number): HealthHistoryRow[] {
    const cap = Math.max(1, Math.min(limit, 5_000));
    return this.db.raw.prepare(
      `SELECT * FROM (
         SELECT * FROM execution_health_history
         WHERE execution_id = ?
         ORDER BY id DESC
         LIMIT ?
       ) ORDER BY id ASC`,
    ).all(executionId, cap) as HealthHistoryRow[];
  }

  /**
   * Retention: drop snapshots older than `cutoffIso`. Returns the
   * number of rows removed. Default cutoff for health = 180 days.
   */
  cleanupExpiredHealth(cutoffIso: string): number {
    const r = this.db.raw.prepare(
      `DELETE FROM execution_health_history WHERE created_at < ?`,
    ).run(cutoffIso);
    return Number(r.changes ?? 0);
  }

  /** Total rows across the health table (for tests / observability). */
  healthSize(): number {
    const r = this.db.raw.prepare(
      `SELECT COUNT(*) AS c FROM execution_health_history`,
    ).get() as { c: number };
    return r.c;
  }
}

/* ---------------- Attention History repo ---------------- */

export class AttentionHistoryRepository {
  constructor(private readonly db: Db) {}

  insertAttention(args: {
    executionId: string;
    attentionKey: string;
    lifecycle: AttentionLifecycleState;
    severity: string;
    reason: string;
    nowIso: string;
  }): void {
    this.db.raw.prepare(
      `INSERT INTO execution_attention_history
         (execution_id, attention_key, lifecycle_state, severity, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.executionId,
      args.attentionKey,
      args.lifecycle,
      args.severity,
      args.reason,
      args.nowIso,
    );
  }

  /**
   * Read up to `limit` entries for an execution, oldest-first.
   * `recovered`-only executions that have been re-detected
   * (current state = 'detected' or 'ongoing') are still returned
   * because we want the full history.
   */
  readAttention(executionId: string, limit: number): AttentionHistoryRow[] {
    const cap = Math.max(1, Math.min(limit, 5_000));
    return this.db.raw.prepare(
      `SELECT * FROM (
         SELECT * FROM execution_attention_history
         WHERE execution_id = ?
         ORDER BY id DESC
         LIMIT ?
       ) ORDER BY id ASC`,
    ).all(executionId, cap) as AttentionHistoryRow[];
  }

  /**
   * Current lifecycle state of (executionId, attentionKey) — the row
   * with the highest id for that pair. Null if the pair has never
   * been recorded.
   */
  getAttentionState(
    executionId: string,
    attentionKey: string,
  ): AttentionLifecycleState | null {
    const row = this.db.raw.prepare(
      `SELECT lifecycle_state FROM execution_attention_history
       WHERE execution_id = ? AND attention_key = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(executionId, attentionKey) as { lifecycle_state: AttentionLifecycleState } | undefined;
    return row?.lifecycle_state ?? null;
  }

  /**
   * Attention is naturally bounded (only state transitions are
   * written), so we don't auto-cleanup by default. This method is
   * provided for completeness; callers can call it manually with
   * a cutoff if needed.
   */
  cleanupExpiredAttention(cutoffIso: string): number {
    const r = this.db.raw.prepare(
      `DELETE FROM execution_attention_history WHERE created_at < ?`,
    ).run(cutoffIso);
    return Number(r.changes ?? 0);
  }

  attentionSize(): number {
    const r = this.db.raw.prepare(
      `SELECT COUNT(*) AS c FROM execution_attention_history`,
    ).get() as { c: number };
    return r.c;
  }
}

/* ---------------- JSON helpers ---------------- */

/** Convert a stored factors_json string to HealthFactor[]; tolerant of garbage. */
export function decodeFactors(json: string | null | undefined): HealthFactor[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f): f is HealthFactor =>
        typeof f === 'object' && f !== null
        && typeof f.name === 'string'
        && typeof f.impact === 'number'
        && typeof f.reason === 'string',
    );
  } catch {
    return [];
  }
}

/* ---------------- Defaults ---------------- */

/** Default retention window for health snapshots. */
export const DEFAULT_HEALTH_RETENTION_DAYS = 180;

/** Convert a "days ago" cutoff to ISO. */
export function healthRetentionCutoffIso(nowMs: number, days: number = DEFAULT_HEALTH_RETENTION_DAYS): string {
  return new Date(nowMs - days * 24 * 60 * 60_000).toISOString();
}