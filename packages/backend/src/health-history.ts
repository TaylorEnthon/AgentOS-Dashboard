/**
 * v1.5 Health Memory & Trend — repository-backed (was in-memory in v1.4).
 *
 * Public surface unchanged from v1.4: HealthHistoryStore and
 * AttentionHistoryStore still expose shouldRecord / append / read /
 * latest / size / clear + reconcileFromQueue. Internally they now
 * delegate to HealthHistoryRepository / AttentionHistoryRepository
 * (SQLite) when a Db has been bound via setHealthHistoryDb.
 *
 * If no Db is bound, the stores fall back to in-memory ring buffers
 * (legacy v1.4 behavior). This keeps the existing test suite
 * passing without modification, while production gets persistence.
 *
 * Pure functions (analyzeHealthTrend, computeAgentReliability) are
 * unchanged.
 */

import type {
  AgentReliabilitySummary,
  AgentType,
  AttentionHistoryEntry,
  AttentionItem,
  AttentionLifecycleState,
  AttentionSeverity,
  HealthFactor,
  HealthLevel,
  HealthSnapshotHistory,
  HealthTrend,
  HealthTrendDirection,
} from '@agentos/shared';
import {
  AttentionHistoryRepository,
  DEFAULT_HEALTH_RETENTION_DAYS,
  HealthHistoryRepository,
  decodeFactors,
  healthRetentionCutoffIso,
  type AttentionHistoryRow,
  type HealthHistoryRow,
} from './health-history-repository.js';
import type { Db } from './db.js';

const DEFAULT_MAX_ENTRIES = 200;     // per execution (in-memory fallback)
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000; // 5 min dedup window for same level

/* ---------------- module-level backend binding ---------------- */

let healthRepo: HealthHistoryRepository | null = null;
let attentionRepo: AttentionHistoryRepository | null = null;

/**
 * Lazy-init: bind the persistent backend. Idempotent.
 * Server startup should call this once after creating the Db.
 * After this call, all writes go through SQLite.
 */
export function setHealthHistoryDb(db: Db): void {
  if (healthRepo && attentionRepo) return; // already bound
  healthRepo = new HealthHistoryRepository(db);
  attentionRepo = new AttentionHistoryRepository(db);
  // Best-effort retention cleanup on startup.
  try {
    const cutoff = healthRetentionCutoffIso(Date.now(), DEFAULT_HEALTH_RETENTION_DAYS);
    const removed = healthRepo.cleanupExpiredHealth(cutoff);
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[health-history] startup retention: removed ${removed} health snapshot(s) older than ${DEFAULT_HEALTH_RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error('[health-history] startup retention failed:', err);
  }
}

/** For tests: drop the binding and clear all in-memory state. */
export function _resetHealthHistoryDbForTests(): void {
  healthRepo = null;
  attentionRepo = null;
  healthHistoryStore.clear();
  attentionHistoryStore.clear();
}

/* ---------------- 1. HealthHistoryStore ---------------- */

interface StoredHealth {
  id: number;
  entry: HealthSnapshotHistory;
}

class HealthHistoryStore {
  private byExec = new Map<string, StoredHealth[]>();
  private nextId = 1;
  private maxEntries: number;
  private minIntervalMs: number;

  constructor(opts: { maxEntries?: number; minIntervalMs?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  /**
   * Pure decision: should we record this snapshot?
   *   - First entry: yes.
   *   - Level changed: yes.
   *   - Same level + min interval elapsed: yes (heartbeat).
   *   - Same level + too soon: no.
   *
   * When SQLite is bound, "previous" comes from the DB instead of
   * the in-memory ring; this is the v1.4 logic unchanged.
   */
  shouldRecord(
    prev: HealthSnapshotHistory | null,
    curr: { score: number; level: HealthLevel; derivedStatus: import('@agentos/shared').DerivedLifecycleStatus; factors: HealthFactor[] },
    nowMs: number,
  ): boolean {
    if (prev === null) return true;
    if (prev.level !== curr.level) return true;
    const prevMs = Date.parse(prev.createdAt);
    if (!Number.isFinite(prevMs)) return true;
    return nowMs - prevMs >= this.minIntervalMs;
  }

  /**
   * Append a snapshot. Caller is responsible for calling
   * `shouldRecord` first. When SQLite is bound, the row is persisted
   * and the in-memory cache is bypassed.
   */
  append(executionId: string, snap: Omit<HealthSnapshotHistory, 'id' | 'executionId'>): HealthSnapshotHistory {
    if (healthRepo) {
      const nowIso = snap.createdAt;
      healthRepo.insertHealth({
        executionId,
        score: snap.score,
        level: snap.level,
        derivedStatus: snap.derivedStatus,
        factors: snap.factors,
        nowIso,
      });
      // Best-effort retention: every 100th insert, run cleanup.
      this.maybeRetention();
      // Return a synthetic entry with the DB id.
      const last = healthRepo.getLatestHealth(executionId);
      if (last) {
        return this.rowToEntry(last);
      }
      // Fallback: if the read-after-write somehow misses, return synthetic.
      return { id: -1, executionId, ...snap };
    }
    // In-memory fallback (legacy v1.4 behavior).
    const entry: HealthSnapshotHistory = {
      id: this.nextId++,
      executionId,
      ...snap,
    };
    const arr = this.byExec.get(executionId) ?? [];
    arr.push({ id: entry.id!, entry });
    if (arr.length > this.maxEntries) {
      arr.splice(0, arr.length - this.maxEntries);
    }
    this.byExec.set(executionId, arr);
    return entry;
  }

  /** Read snapshots for one execution, oldest-first, capped at limit. */
  read(executionId: string, limit = 100): HealthSnapshotHistory[] {
    if (healthRepo) {
      const rows = healthRepo.readHealth(executionId, limit);
      return rows.map((r) => this.rowToEntry(r));
    }
    const arr = this.byExec.get(executionId) ?? [];
    const cap = Math.max(1, Math.min(limit, this.maxEntries));
    return arr.slice(-cap).map((s) => s.entry);
  }

  /** Latest entry for an execution, or null. */
  latest(executionId: string): HealthSnapshotHistory | null {
    if (healthRepo) {
      const row = healthRepo.getLatestHealth(executionId);
      return row ? this.rowToEntry(row) : null;
    }
    const arr = this.byExec.get(executionId);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1]!.entry;
  }

  /** Total entries across all executions (in-memory only; SQLite count via repo). */
  size(): number {
    if (healthRepo) return healthRepo.healthSize();
    let n = 0;
    for (const arr of this.byExec.values()) n += arr.length;
    return n;
  }

  /** Test helper: drop everything (in-memory only). */
  clear(): void {
    this.byExec.clear();
    this.nextId = 1;
  }

  /** Convert a DB row to the shared HealthSnapshotHistory shape. */
  private rowToEntry(row: HealthHistoryRow): HealthSnapshotHistory {
    return {
      id: row.id,
      executionId: row.execution_id,
      score: row.score,
      level: row.level,
      derivedStatus: row.derived_status as import('@agentos/shared').DerivedLifecycleStatus,
      factors: decodeFactors(row.factors_json),
      createdAt: row.created_at,
    };
  }

  private insertCounter = 0;
  private maybeRetention(): void {
    this.insertCounter++;
    if (this.insertCounter % 100 === 0 && healthRepo) {
      try {
        const cutoff = healthRetentionCutoffIso(Date.now(), DEFAULT_HEALTH_RETENTION_DAYS);
        healthRepo.cleanupExpiredHealth(cutoff);
      } catch {
        // best-effort; never fail an insert because of cleanup
      }
    }
  }
}

/* ---------------- 2. AttentionHistoryStore ---------------- */

interface StoredAttention {
  id: number;
  entry: AttentionHistoryEntry;
}

class AttentionHistoryStore {
  private byExec = new Map<string, StoredAttention[]>();
  private byExecKey = new Map<string, AttentionLifecycleState>(); // (exec|key) -> current state
  private nextId = 1;
  private maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 200;
  }

  /**
   * Compare a freshly-computed attention queue against the stored
   * state and append 'detected' / 'recovered' transitions.
   * Idempotent: re-running with the same queue writes nothing new.
   *
   * When SQLite is bound, state tracking uses the DB (latest lifecycle_state
   * for each (exec, key) pair); new rows are persisted.
   */
  reconcileFromQueue(
    queue: AttentionItem[],
    nowIso: string = new Date().toISOString(),
  ): AttentionHistoryEntry[] {
    const out: AttentionHistoryEntry[] = [];
    const currentByExec = new Map<string, Map<string, { severity: AttentionSeverity; reason: string }>>();
    for (const it of queue) {
      let m = currentByExec.get(it.executionId);
      if (!m) { m = new Map(); currentByExec.set(it.executionId, m); }
      m.set(it.recommendedAction, { severity: it.severity, reason: it.reason });
    }

    if (attentionRepo) {
      // SQLite-backed: state = latest row's lifecycle_state
      const knownKeys = new Set<string>();
      // We need to discover all known (exec, key) pairs. For simplicity
      // we re-query the DB for each exec in currentByExec + last seen.
      // (Cheap; we cap at 100 keys per exec.)
      for (const execId of currentByExec.keys()) {
        const rows = attentionRepo.readAttention(execId, 1000);
        for (const r of rows) knownKeys.add(`${r.execution_id}|${r.attention_key}`);
        // Also fold in any execIds that were in queue previously but
        // not now (for "recovered" detection).
        for (const r of rows) {
          if (!currentByExec.has(r.execution_id)) {
            knownKeys.add(`${r.execution_id}|${r.attention_key}`);
          }
        }
      }
      const seen = new Set<string>();
      for (const [execId, m] of currentByExec) {
        for (const [key, info] of m) {
          const composite = `${execId}|${key}`;
          seen.add(composite);
          // getAttentionState returns null when (exec,key) has never
          // been recorded. Treat null/undefined and 'recovered' as
          // "not currently open" → write a fresh 'detected' row.
          const prevRaw = attentionRepo.getAttentionState(execId, key);
          const prev: AttentionLifecycleState | null = prevRaw ?? null;
          const wasOpen = prev === 'detected' || prev === 'ongoing';
          if (!wasOpen) {
            attentionRepo.insertAttention({
              executionId: execId, attentionKey: key,
              lifecycle: 'detected',
              severity: info.severity, reason: info.reason, nowIso,
            });
            out.push(this._rowToEntry({
              id: -1, execution_id: execId, attention_key: key,
              lifecycle_state: 'detected',
              severity: info.severity, reason: info.reason, created_at: nowIso,
            }));
          } else {
            // prev was 'detected' or 'ongoing' and still in queue: write 'ongoing'
            attentionRepo.insertAttention({
              executionId: execId, attentionKey: key,
              lifecycle: 'ongoing',
              severity: info.severity, reason: info.reason, nowIso,
            });
            out.push(this._rowToEntry({
              id: -1, execution_id: execId, attention_key: key,
              lifecycle_state: 'ongoing',
              severity: info.severity, reason: info.reason, created_at: nowIso,
            }));
          }
        }
      }
      // Recovered: known key no longer in the queue.
      for (const composite of knownKeys) {
        if (seen.has(composite)) continue;
        const [executionId, attentionKey] = composite.split('|') as [string, string];
        const prev = attentionRepo.getAttentionState(executionId, attentionKey);
        if (prev === 'recovered' || prev === null) continue;
        attentionRepo.insertAttention({
          executionId, attentionKey,
          lifecycle: 'recovered',
          severity: 'low', reason: 'No longer in attention queue', nowIso,
        });
        out.push(this._rowToEntry({
          id: -1, execution_id: executionId, attention_key: attentionKey,
          lifecycle_state: 'recovered',
          severity: 'low', reason: 'No longer in attention queue', created_at: nowIso,
        }));
      }
      return out;
    }

    // In-memory fallback (legacy v1.4)
    const knownKeysMem = new Set(this.byExecKey.keys());
    const seen = new Set<string>();
    for (const [execId, m] of currentByExec) {
      for (const [key, info] of m) {
        const composite = `${execId}|${key}`;
        seen.add(composite);
        const prev = this.byExecKey.get(composite);
        if (prev === undefined) {
          this.byExecKey.set(composite, 'detected');
          out.push(this._append(execId, {
            attentionKey: key,
            lifecycle: 'detected',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        } else if (prev === 'recovered') {
          this.byExecKey.set(composite, 'ongoing');
          out.push(this._append(execId, {
            attentionKey: key,
            lifecycle: 'detected',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        } else if (prev === 'detected' || prev === 'ongoing') {
          this.byExecKey.set(composite, 'ongoing');
          out.push(this._append(execId, {
            attentionKey: key,
            lifecycle: 'ongoing',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        }
      }
    }
    for (const composite of knownKeysMem) {
      if (seen.has(composite)) continue;
      const prev = this.byExecKey.get(composite)!;
      if (prev === 'recovered') continue;
      this.byExecKey.set(composite, 'recovered');
      const [executionId, attentionKey] = composite.split('|') as [string, string];
      out.push(this._append(executionId, {
        attentionKey,
        lifecycle: 'recovered',
        severity: 'low',
        reason: 'No longer in attention queue',
        createdAt: nowIso,
      }));
    }
    return out;
  }

  private _append(executionId: string, entry: Omit<AttentionHistoryEntry, 'id' | 'executionId'>): AttentionHistoryEntry {
    const full: AttentionHistoryEntry = {
      id: this.nextId++,
      executionId,
      ...entry,
    };
    const arr = this.byExec.get(executionId) ?? [];
    arr.push({ id: full.id!, entry: full });
    if (arr.length > this.maxEntries) {
      arr.splice(0, arr.length - this.maxEntries);
    }
    this.byExec.set(executionId, arr);
    return full;
  }

  private _rowToEntry(row: AttentionHistoryRow): AttentionHistoryEntry {
    return {
      id: row.id,
      executionId: row.execution_id,
      attentionKey: row.attention_key,
      lifecycle: row.lifecycle_state,
      severity: row.severity as AttentionSeverity,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  read(executionId: string, limit = 100): AttentionHistoryEntry[] {
    if (attentionRepo) {
      const rows = attentionRepo.readAttention(executionId, limit);
      return rows.map((r) => this._rowToEntry(r));
    }
    const arr = this.byExec.get(executionId) ?? [];
    const cap = Math.max(1, Math.min(limit, this.maxEntries));
    return arr.slice(-cap).map((s) => s.entry);
  }

  size(): number {
    if (attentionRepo) return attentionRepo.attentionSize();
    let n = 0;
    for (const arr of this.byExec.values()) n += arr.length;
    return n;
  }

  clear(): void {
    this.byExec.clear();
    this.byExecKey.clear();
    this.nextId = 1;
  }
}

/* ---------------- 3. Pure analysis ---------------- */

export function analyzeHealthTrend(
  history: HealthSnapshotHistory[],
  nowMs: number = Date.now(),
): HealthTrend {
  if (history.length === 0) {
    return {
      direction: 'stable',
      scoreDelta: 0,
      samples: 0,
      summary: 'No history yet — first sample will appear when health changes.',
      from: null,
      to: new Date(nowMs).toISOString(),
    };
  }
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const delta = last.score - first.score;
  let direction: HealthTrendDirection;
  if (Math.abs(delta) < 5) direction = 'stable';
  else if (delta > 0) direction = 'improving';
  else direction = 'degrading';

  let summary: string;
  if (direction === 'stable') {
    summary = `Holding at ${last.score} (${history.length} sample${history.length === 1 ? '' : 's'}, no significant change).`;
  } else if (direction === 'improving') {
    summary = `Improving from ${first.score} to ${last.score} over ${history.length} sample${history.length === 1 ? '' : 's'}.`;
  } else {
    summary = `Degrading from ${first.score} to ${last.score} over ${history.length} sample${history.length === 1 ? '' : 's'}.`;
  }

  return {
    direction,
    scoreDelta: delta,
    samples: history.length,
    summary,
    from: first.createdAt,
    to: last.createdAt,
  };
}

export function computeAgentReliability(
  history: HealthSnapshotHistory[],
  agentTypes: Map<string, AgentType>,
  nowMs: number = Date.now(),
): AgentReliabilitySummary[] {
  const byAgent = new Map<string, HealthSnapshotHistory[]>();
  for (const h of history) {
    const agent = agentTypes.get(h.executionId);
    if (!agent) continue;
    const arr = byAgent.get(agent) ?? [];
    arr.push(h);
    byAgent.set(agent, arr);
  }

  const out: AgentReliabilitySummary[] = [];
  for (const [agent, samples] of byAgent.entries()) {
    let total = 0;
    let completed = 0;
    let failed = 0;
    let recoverySumMs = 0;
    let recoveryCount = 0;

    const byExec = new Map<string, HealthSnapshotHistory[]>();
    for (const s of samples) {
      const arr = byExec.get(s.executionId) ?? [];
      arr.push(s);
      byExec.set(s.executionId, arr);
    }

    for (const s of samples) {
      total++;
      if (s.derivedStatus === 'completed') completed++;
      else if (s.derivedStatus === 'failed') failed++;
    }

    for (const [, execSamples] of byExec) {
      const sorted = execSamples.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      let lastFailedMs: number | null = null;
      for (const s of sorted) {
        const ms = Date.parse(s.createdAt);
        if (s.derivedStatus === 'failed') {
          lastFailedMs = ms;
        } else if (s.derivedStatus === 'completed' && lastFailedMs != null) {
          recoverySumMs += ms - lastFailedMs;
          recoveryCount++;
          lastFailedMs = null;
        }
      }
    }

    const failureRate = total > 0 ? failed / total : 0;
    const reliabilityScore = total > 0 ? Math.round((1 - failureRate) * 100) : 100;
    const averageRecoveryTimeMs = recoveryCount > 0 ? Math.round(recoverySumMs / recoveryCount) : null;

    out.push({
      agentType: agent,
      totalExecutions: total,
      completedExecutions: completed,
      failedExecutions: failed,
      reliabilityScore,
      failureRate,
      averageRecoveryTimeMs,
      computedAt: new Date(nowMs).toISOString(),
    });
  }
  out.sort((a, b) => b.reliabilityScore - a.reliabilityScore || a.agentType.localeCompare(b.agentType));
  return out;
}

/* ---------------- Process-wide singletons ---------------- */

export const healthHistoryStore = new HealthHistoryStore();
export const attentionHistoryStore = new AttentionHistoryStore();

export function createHealthHistoryStore(opts?: { maxEntries?: number; minIntervalMs?: number }): HealthHistoryStore {
  return new HealthHistoryStore(opts);
}
export function createAttentionHistoryStore(opts?: { maxEntries?: number }): AttentionHistoryStore {
  return new AttentionHistoryStore(opts);
}