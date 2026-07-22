/**
 * v1.4 Agent Health Memory & Trend — in-memory history stores
 * and pure analysis functions.
 *
 * Three responsibilities:
 *   1. HealthHistoryStore     — per-execution snapshot log (deduped)
 *   2. AttentionHistoryStore  — per-(execution, key) lifecycle log
 *   3. Pure analysis:          analyzeHealthTrend + computeAgentReliability
 *
 * Storage is in-memory (matches v1.2 cache philosophy). Process
 * restart wipes the history; v1.4 is a v1 trend, not an audit log.
 * We deliberately do NOT touch sessions / activity_events / collectors.
 *
 * Hooks in routes.ts:
 *   - After /health computes a score, call `shouldRecordHealthSnapshot`
 *     to decide whether to write. If yes, push to HealthHistoryStore.
 *   - After /attention builds a queue, diff against AttentionHistoryStore
 *     and record 'detected' / 'recovered' transitions.
 */

import type {
  AgentReliabilitySummary,
  AgentType,
  AttentionHistoryEntry,
  AttentionItem,
  AttentionLifecycleState,
  AttentionSeverity,
  HealthLevel,
  HealthSnapshotHistory,
  HealthTrend,
  HealthTrendDirection,
} from '@agentos/shared';

/* ---------------- 1. HealthHistoryStore ---------------- */

const DEFAULT_MAX_ENTRIES = 200;     // per execution
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000; // 5 min dedup window for same level

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
   */
  shouldRecord(
    prev: HealthSnapshotHistory | null,
    curr: { score: number; level: HealthLevel; derivedStatus: import('@agentos/shared').DerivedLifecycleStatus; factors: import('@agentos/shared').HealthFactor[] },
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
   * `shouldRecord` first; this method does not re-check.
   */
  append(executionId: string, snap: Omit<HealthSnapshotHistory, 'id' | 'executionId'>): HealthSnapshotHistory {
    const entry: HealthSnapshotHistory = {
      id: this.nextId++,
      executionId,
      ...snap,
    };
    const arr = this.byExec.get(executionId) ?? [];
    arr.push({ id: entry.id!, entry });
    // Ring-buffer trim (keep the most recent N).
    if (arr.length > this.maxEntries) {
      arr.splice(0, arr.length - this.maxEntries);
    }
    this.byExec.set(executionId, arr);
    return entry;
  }

  /** Read snapshots for one execution, oldest-first, capped at limit. */
  read(executionId: string, limit = 100): HealthSnapshotHistory[] {
    const arr = this.byExec.get(executionId) ?? [];
    const cap = Math.max(1, Math.min(limit, this.maxEntries));
    return arr.slice(-cap).map((s) => s.entry);
  }

  /** Latest entry for an execution, or null. */
  latest(executionId: string): HealthSnapshotHistory | null {
    const arr = this.byExec.get(executionId);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1]!.entry;
  }

  /** Total entries across all executions (for tests). */
  size(): number {
    let n = 0;
    for (const arr of this.byExec.values()) n += arr.length;
    return n;
  }

  /** Test helper: drop everything. */
  clear(): void {
    this.byExec.clear();
    this.nextId = 1;
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
   * `current` is the key list (e.g. `["review-conflict", "investigate-blocked"]`)
   * per executionId. Items not in the current list are "recovered".
   */
  reconcileFromQueue(
    queue: AttentionItem[],
    nowIso: string = new Date().toISOString(),
  ): AttentionHistoryEntry[] {
    const out: AttentionHistoryEntry[] = [];
    // Build current map: execId -> set of (key -> { severity, reason })
    const currentByExec = new Map<string, Map<string, { severity: AttentionSeverity; reason: string }>>();
    for (const it of queue) {
      let m = currentByExec.get(it.executionId);
      if (!m) { m = new Map(); currentByExec.set(it.executionId, m); }
      m.set(it.recommendedAction, { severity: it.severity, reason: it.reason });
    }

    // Walk every (exec, key) we know about and detect transitions.
    const knownKeys = new Set(this.byExecKey.keys());
    const seen = new Set<string>();
    for (const [execId, m] of currentByExec) {
      for (const [key, info] of m) {
        const composite = `${execId}|${key}`;
        seen.add(composite);
        const prev = this.byExecKey.get(composite);
        if (prev === undefined) {
          this.byExecKey.set(composite, 'detected');
          out.push(this._append(execId, {
            executionId: execId,
            attentionKey: key,
            lifecycle: 'detected',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        } else if (prev === 'recovered') {
          this.byExecKey.set(composite, 'ongoing');
          out.push(this._append(execId, {
            executionId: execId,
            attentionKey: key,
            lifecycle: 'detected',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        }
        // prev was 'detected' or 'ongoing' and still in queue: write a heartbeat 'ongoing'
        // (only every N seconds; we always write here for simplicity, tests can dedupe).
        else if (prev === 'detected' || prev === 'ongoing') {
          this.byExecKey.set(composite, 'ongoing');
          out.push(this._append(execId, {
            executionId: execId,
            attentionKey: key,
            lifecycle: 'ongoing',
            severity: info.severity,
            reason: info.reason,
            createdAt: nowIso,
          }));
        }
      }
    }
    // Recovered: known key no longer in the queue.
    for (const composite of knownKeys) {
      if (seen.has(composite)) continue;
      const prev = this.byExecKey.get(composite)!;
      if (prev === 'recovered') continue; // already recovered, no need to repeat
      this.byExecKey.set(composite, 'recovered');
      const [executionId, attentionKey] = composite.split('|') as [string, string];
      out.push(this._append(executionId, {
        executionId,
        attentionKey,
        lifecycle: 'recovered',
        severity: 'low', // recovered is informational
        reason: 'No longer in attention queue',
        createdAt: nowIso,
      }));
    }
    return out;
  }

  private _append(executionId: string, entry: Omit<AttentionHistoryEntry, 'id'>): AttentionHistoryEntry {
    const full: AttentionHistoryEntry = {
      id: this.nextId++,
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

  read(executionId: string, limit = 100): AttentionHistoryEntry[] {
    const arr = this.byExec.get(executionId) ?? [];
    const cap = Math.max(1, Math.min(limit, this.maxEntries));
    return arr.slice(-cap).map((s) => s.entry);
  }

  size(): number {
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

/**
 * Pure: given a list of HealthSnapshotHistory rows, return a trend
 * direction + score delta.
 *
 * Direction is based on the scoreDelta:
 *   |delta| < 5  -> 'stable'
 *   delta > 0    -> 'improving'
 *   delta < 0    -> 'degrading'
 */
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

/**
 * Pure: aggregate HealthSnapshotHistory rows by `executionId.split(':')[0]`
 * (i.e. the agentType prefix) into per-agent reliability summaries.
 *
 * "Completed" vs "failed" classification is by derivedStatus at
 * snapshot time. Recovery time is the average ms from a 'failed'
 * snapshot to the next 'completed' snapshot within the same execution.
 */
export function computeAgentReliability(
  history: HealthSnapshotHistory[],
  agentTypes: Map<string, AgentType>, // executionId -> agentType
  nowMs: number = Date.now(),
): AgentReliabilitySummary[] {
  // Group by agent
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

    // Group by execution for recovery calculation.
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
      // Find each failed -> next completed transition.
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
  // Sort by reliability score desc for stable UI.
  out.sort((a, b) => b.reliabilityScore - a.reliabilityScore || a.agentType.localeCompare(b.agentType));
  return out;
}

/* ---------------- Process-wide singletons ---------------- */

export const healthHistoryStore = new HealthHistoryStore();
export const attentionHistoryStore = new AttentionHistoryStore();

/** Test helpers — create isolated instances. */
export function createHealthHistoryStore(opts?: { maxEntries?: number; minIntervalMs?: number }): HealthHistoryStore {
  return new HealthHistoryStore(opts);
}
export function createAttentionHistoryStore(opts?: { maxEntries?: number }): AttentionHistoryStore {
  return new AttentionHistoryStore(opts);
}