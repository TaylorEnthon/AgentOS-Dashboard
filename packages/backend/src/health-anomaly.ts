/**
 * v1.6 Health Anomaly Detection — pure-function module.
 *
 * Given a sequence of `HealthSnapshotHistory` (oldest-first), detect
 * anomalies that warrant user attention. Deterministic: same input →
 * same output, no time-of-day bias (apart from the optional `nowMs`
 * hook used only by callers that need a deterministic timestamp).
 *
 * Three categories:
 *   1. score-drop         — adjacent snapshot dropped by ≥ scoreDropThreshold
 *   2. level-regression   — level moved toward 'critical' (healthy→warning→critical)
 *   3. rapid-degradation  — sliding window of N snapshots dropped by ≥ rapidDegradationThreshold
 *
 * Output severity:
 *   - 'critical'  — large or compounding drops (≥ critical multipliers)
 *   - 'high'      — everything else
 *
 * Read-only: never writes to DB or mutates inputs. Safe to call from
 * any layer.
 */

import type {
  HealthAnomaly,
  HealthAnomalyKind,
  HealthAnomalyOptions,
  HealthAnomalySeverity,
  HealthLevel,
  HealthSnapshotHistory,
} from '@agentos/shared';

/* ---------------- thresholds ---------------- */

const DEFAULT_SCORE_DROP_THRESHOLD = 30;
const DEFAULT_RAPID_DEGRADATION_THRESHOLD = 40;
const DEFAULT_RAPID_DEGRADATION_WINDOW = 3;

/** Multipliers above the base threshold that escalate to 'critical'. */
const CRITICAL_SCORE_DROP_MULTIPLIER = 2;       // ≥ 2x scoreDropThreshold = critical
const CRITICAL_RAPID_MULTIPLIER = 2;            // ≥ 2x rapidDegradationThreshold = critical

/* ---------------- level ordering ---------------- */

/** Higher number = worse. */
const LEVEL_RANK: Record<HealthLevel, number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
};

function rankToLevel(rank: number): HealthLevel {
  if (rank <= 0) return 'healthy';
  if (rank === 1) return 'warning';
  return 'critical';
}

function levelDelta(from: HealthLevel, to: HealthLevel): number {
  return LEVEL_RANK[to] - LEVEL_RANK[from];
}

/* ---------------- public API ---------------- */

/**
 * Pure function. Returns all anomalies in detection order
 * (oldest → newest). An empty array means "no anomalies detected".
 *
 * `nowMs` is used only as a fallback timestamp when the input lacks
 * `createdAt`; under normal use every snapshot has one.
 */
export function detectHealthAnomalies(
  history: HealthSnapshotHistory[],
  options: HealthAnomalyOptions = {},
): HealthAnomaly[] {
  const scoreDropThreshold = options.scoreDropThreshold ?? DEFAULT_SCORE_DROP_THRESHOLD;
  const rapidThreshold     = options.rapidDegradationThreshold ?? DEFAULT_RAPID_DEGRADATION_THRESHOLD;
  const rapidWindow        = Math.max(2, options.rapidDegradationWindow ?? DEFAULT_RAPID_DEGRADATION_WINDOW);

  if (history.length < 2) return [];

  const out: HealthAnomaly[] = [];
  const seen = new Set<string>(); // dedup by (idx, kind)

  // 1. score-drop + level-regression: pairwise over adjacent snapshots.
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const curr = history[i]!;
    const drop = prev.score - curr.score;
    if (drop >= scoreDropThreshold) {
      const kind: HealthAnomalyKind = 'score-drop';
      const key = `${i}|${kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(makeAnomaly({
          executionId: curr.executionId,
          kind,
          fromScore: prev.score,
          toScore: curr.score,
          fromLevel: prev.level,
          toLevel: curr.level,
          fromAt: prev.createdAt,
          detectedAt: curr.createdAt,
          drop,
          scoreDropThreshold,
          rapidThreshold,
        }));
      }
    }
    const dl = levelDelta(prev.level, curr.level);
    if (dl > 0) {
      const kind: HealthAnomalyKind = 'level-regression';
      const key = `${i}|${kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(makeAnomaly({
          executionId: curr.executionId,
          kind,
          fromScore: prev.score,
          toScore: curr.score,
          fromLevel: prev.level,
          toLevel: curr.level,
          fromAt: prev.createdAt,
          detectedAt: curr.createdAt,
          drop,
          scoreDropThreshold,
          rapidThreshold,
        }));
      }
    }
  }

  // 2. rapid-degradation: sliding window over the last N snapshots
  // (counted as N entries, including the current one).
  for (let i = rapidWindow - 1; i < history.length; i++) {
    const earliest = history[i - (rapidWindow - 1)]!;
    const latest = history[i]!;
    const drop = earliest.score - latest.score;
    if (drop >= rapidThreshold) {
      const kind: HealthAnomalyKind = 'rapid-degradation';
      // dedup by window-end index — overlapping windows may repeat
      // the same anomaly; keep one per "trigger point".
      const key = `${i}|${kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(makeAnomaly({
          executionId: latest.executionId,
          kind,
          fromScore: earliest.score,
          toScore: latest.score,
          fromLevel: earliest.level,
          toLevel: latest.level,
          fromAt: earliest.createdAt,
          detectedAt: latest.createdAt,
          drop,
          scoreDropThreshold,
          rapidThreshold,
        }));
      }
    }
  }

  return out;
}

/* ---------------- helpers ---------------- */

interface AnomalyBuildArgs {
  executionId: string;
  kind: HealthAnomalyKind;
  fromScore: number;
  toScore: number;
  fromLevel: HealthLevel | null;
  toLevel: HealthLevel;
  fromAt: string;
  detectedAt: string;
  drop: number;
  scoreDropThreshold: number;
  rapidThreshold: number;
}

function makeAnomaly(a: AnomalyBuildArgs): HealthAnomaly {
  const severity: HealthAnomalySeverity = severityFor(a);
  return {
    executionId: a.executionId,
    kind: a.kind,
    severity,
    fromScore: a.fromScore,
    toScore: a.toScore,
    fromLevel: a.fromLevel,
    toLevel: a.toLevel,
    fromAt: a.fromAt,
    detectedAt: a.detectedAt,
    message: messageFor(a),
  };
}

function severityFor(a: AnomalyBuildArgs): HealthAnomalySeverity {
  if (a.kind === 'level-regression' && a.toLevel === 'critical') return 'critical';
  const threshold = a.kind === 'rapid-degradation' ? a.rapidThreshold : a.scoreDropThreshold;
  return a.drop >= threshold * CRITICAL_SCORE_DROP_MULTIPLIER ? 'critical' : 'high';
}

function messageFor(a: AnomalyBuildArgs): string {
  switch (a.kind) {
    case 'score-drop':
      return `Score dropped from ${a.fromScore} to ${a.toScore} (-${a.drop}).`;
    case 'level-regression':
      return `Level regressed from ${a.fromLevel ?? 'unknown'} to ${a.toLevel}.`;
    case 'rapid-degradation':
      return `Score fell ${a.drop} over the last ${a.toScore} → ${a.fromScore}.`;
  }
}

/**
 * Bridge for the Attention Queue (v1.6): turn `HealthAnomaly[]` into
 * a stream of "virtual attention items" with severity high/critical.
 *
 * Pure / read-only: never persisted. Caller decides whether to
 * inject into the live queue (it shouldn't — we keep them out of
 * reconcileFromQueue's persisted history) or just expose via API.
 */
export function anomaliesToAttentionItems(anomalies: HealthAnomaly[]): Array<{
  executionId: string;
  severity: HealthAnomalySeverity;
  reason: string;
  recommendedAction: 'investigate-anomaly';
  derivedStatus: null;
  detectedAt: string;
  kind: HealthAnomalyKind;
}> {
  return anomalies.map((a) => ({
    executionId: a.executionId,
    severity: a.severity,
    reason: a.message,
    recommendedAction: 'investigate-anomaly',
    derivedStatus: null,
    detectedAt: a.detectedAt,
    kind: a.kind,
  }));
}