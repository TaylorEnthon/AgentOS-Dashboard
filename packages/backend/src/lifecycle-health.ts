/**
 * v1.3 Agent Health Intelligence Foundation — pure projection layer.
 *
 * Four pure functions, all input-only:
 *   1. `computeHealthScore`     LifecycleSnapshot + LifecycleConflict  →  HealthScore
 *   2. `explainLifecycle`       LifecycleSnapshot + LifecycleConflict  →  Explanation
 *   3. `buildAttentionQueue`    (snapshots + conflicts)[]               →  AttentionItem[]
 *   4. `computeWorkspaceSummary` (snapshots + conflicts)[]               →  Summary
 *
 * No DB, no clock, no scheduler. All `now` values are injectable.
 * Deterministic: same inputs ⇒ same outputs.
 *
 * The whole module is intentionally rule-based (no scoring model / ML).
 * Each "factor" carries a signed `impact` and a human-readable reason;
 * the score is clamped to [0, 100] and bucketed into level by simple
 * thresholds. This makes outputs inspectable and tunable.
 */

import type {
  AttentionAction,
  AttentionItem,
  AttentionSeverity,
  DerivedLifecycleStatus,
  LifecycleConflict,
  LifecycleExplanation,
  LifecycleHealthScore,
  LifecycleSnapshot,
  WorkspaceHealthSummary,
} from '@agentos/shared';

const HEALTHY_THRESHOLD = 80;
const WARNING_THRESHOLD = 50;

const BLOCKED_TOO_LONG_MS = 2 * 60 * 60 * 1000;       // 2h
const IDLE_TOO_LONG_MS = 24 * 60 * 60 * 1000;          // 24h
const FAILED_NEEDS_REVIEW_MS = 30 * 60 * 1000;        // 30min

/* ---------------- 1. computeHealthScore ---------------- */

export interface HealthInputs {
  snapshot: LifecycleSnapshot;
  conflict?: LifecycleConflict | null;
}

/**
 * Pure: derive a LifecycleHealthScore from a snapshot + optional
 * conflict. Impact values are signed:
 *   - positive factors: confidence, fresh activity, completion markers
 *   - negative factors: stalled, conflict, blocked, failed, no activity
 *
 * Score starts at 100, gets knocked down by negative impacts and
 * boosted by positive ones, then clamped to [0, 100]. Bucketed:
 *   >=80  -> healthy
 *   >=50  -> warning
 *   < 50  -> critical
 */
export function computeHealthScore(inputs: HealthInputs): LifecycleHealthScore {
  const factors: LifecycleHealthScore['factors'] = [];
  const snap = inputs.snapshot;
  const conflict = inputs.conflict ?? null;

  // Start at 100 and subtract; we'll clamp at the end.
  let score = 100;

  // Factor: low confidence. We trust the rest less.
  if (snap.confidence === 'low') {
    score -= 30;
    factors.push({
      name: 'low-confidence',
      impact: -30,
      reason: 'Not enough evidence to be sure about lifecycle state',
    });
  } else if (snap.confidence === 'medium') {
    score -= 8;
    factors.push({
      name: 'medium-confidence',
      impact: -8,
      reason: 'Lifecycle state is partially supported; some assumptions made',
    });
  } else {
    factors.push({
      name: 'high-confidence',
      impact: 4,
      reason: 'Multiple strong indicators agree on lifecycle state',
    });
  }

  // Factor: derived status itself.
  switch (snap.derivedStatus) {
    case 'running':
      factors.push({
        name: 'running',
        impact: 8,
        reason: 'Active agent activity within the last 30s',
      });
      score += 8;
      break;
    case 'completed':
      factors.push({
        name: 'completed',
        impact: 5,
        reason: 'Session declared end with evidence of completion',
      });
      score += 5;
      break;
    case 'queued':
      factors.push({
        name: 'queued',
        impact: 0,
        reason: 'Waiting for first activity — normal cold-start state',
      });
      break;
    case 'idle':
      factors.push({
        name: 'idle',
        impact: -25,
        reason: 'No recent activity but no failure markers either',
      });
      score -= 25;
      break;
    case 'blocked':
      factors.push({
        name: 'blocked',
        impact: -55,
        reason: 'Agent committed recently then went silent — likely stuck',
      });
      score -= 55;
      break;
    case 'failed':
      factors.push({
        name: 'failed',
        impact: -60,
        reason: 'Session-end reports a failure or error',
      });
      score -= 60;
      break;
  }

  // Factor: conflict (manual != derived).
  if (conflict && conflict.isConflict) {
    score -= 20;
    factors.push({
      name: 'manual-vs-derived-conflict',
      impact: -20,
      reason: conflict.label
        ? `Your manual status (${conflict.manualStatus}) disagrees with derived (${conflict.derivedStatus})`
        : 'Your manual status disagrees with the derived state',
    });
  }

  // Factor: stale activity. Use lastActivityAgeMs when available.
  if (snap.lastActivityAgeMs != null) {
    if (snap.lastActivityAgeMs > IDLE_TOO_LONG_MS) {
      score -= 15;
      factors.push({
        name: 'long-idle',
        impact: -15,
        reason: 'No activity for over 24 hours',
      });
    } else if (snap.lastActivityAgeMs > BLOCKED_TOO_LONG_MS) {
      score -= 10;
      factors.push({
        name: 'extended-silence',
        impact: -10,
        reason: 'No activity for over 2 hours',
      });
    }
  }

  // Factor: indicators. Many "blocked-threshold-crossed" indicators are
  // signals of trouble; many "recent-activity" indicators are good.
  const positive = snap.indicators.filter((i) => i.type === 'recent-activity' || i.type === 'session-ended').length;
  const negative = snap.indicators.filter((i) =>
    i.type === 'blocked-threshold-crossed'
    || i.type === 'failure-marker'
    || i.type === 'contradiction'
    || i.type === 'no-activity',
  ).length;
  if (positive >= 2) {
    score += 3;
    factors.push({
      name: 'multiple-positive-indicators',
      impact: 3,
      reason: `${positive} strong positive indicators present`,
    });
  }
  if (negative >= 2) {
    score -= 10;
    factors.push({
      name: 'multiple-negative-indicators',
      impact: -10,
      reason: `${negative} concerning indicators present`,
    });
  }

  // Sort factors by absolute impact (descending) for UI stability.
  factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  // Clamp.
  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score: clamped,
    level: clamped >= HEALTHY_THRESHOLD ? 'healthy'
         : clamped >= WARNING_THRESHOLD ? 'warning'
         : 'critical',
    factors,
  };
}

/* ---------------- 2. explainLifecycle ---------------- */

/**
 * Pure: render a LifecycleSnapshot (+ optional conflict) into a
 * short headline + bullet list. Always returns >= 1 bullet.
 */
export function explainLifecycle(
  snapshot: LifecycleSnapshot,
  conflict?: LifecycleConflict | null,
): LifecycleExplanation {
  const bullets: string[] = [];
  let headline: string;

  switch (snapshot.derivedStatus) {
    case 'running':
      headline = 'Agent is actively working.';
      if (snapshot.lastActivityAgeMs != null) {
        const sec = Math.max(1, Math.round(snapshot.lastActivityAgeMs / 1000));
        bullets.push(`Last event ${sec}s ago`);
      } else {
        bullets.push('Recent activity detected');
      }
      bullets.push('No failure markers present');
      if (snapshot.indicators.some((i) => i.type === 'session-ended')) {
        bullets.push('Session end was already declared');
      }
      break;

    case 'blocked':
      headline = 'Agent appears stuck after recent commit.';
      const ageMin = snapshot.lastActivityAgeMs != null
        ? Math.round(snapshot.lastActivityAgeMs / 60_000)
        : null;
      if (ageMin != null) bullets.push(`No activity for ${ageMin} minutes`);
      const commit = snapshot.indicators.find((i) => i.type === 'commit-landed');
      if (commit) bullets.push(`Recent commit: ${commit.label}`);
      bullets.push('No completion or failure marker — agent may have errored out');
      break;

    case 'idle':
      headline = 'Agent is idle.';
      const idleMin = snapshot.lastActivityAgeMs != null
        ? Math.round(snapshot.lastActivityAgeMs / 60_000)
        : null;
      if (idleMin != null) bullets.push(`Last event ${idleMin}m ago`);
      bullets.push('No recent commits and no failure markers');
      bullets.push('May pick up again, or stay idle until manually resumed');
      break;

    case 'completed':
      headline = 'Agent finished.';
      bullets.push('Session declared end time');
      const commitLand = snapshot.indicators.find((i) => i.type === 'commit-landed');
      if (commitLand) bullets.push(commitLand.label);
      bullets.push('Health should remain stable until new activity arrives');
      break;

    case 'failed':
      headline = 'Agent reported a failure.';
      const fail = snapshot.indicators.find((i) => i.type === 'failure-marker');
      bullets.push(fail ? fail.label : 'Failure marker detected in event log');
      bullets.push('Recommend reviewing recent tool calls and error context');
      break;

    case 'queued':
      headline = 'Execution just started; no activity yet.';
      bullets.push('Waiting for first event');
      bullets.push('Could indicate either cold-start or backend ingest lag');
      break;
  }

  if (snapshot.confidence === 'low') {
    bullets.push('Confidence is low — evidence is thin');
  } else if (snapshot.confidence === 'medium') {
    bullets.push('Confidence is medium — partial evidence');
  }

  if (conflict && conflict.isConflict) {
    bullets.unshift(
      `Manual "${conflict.manualStatus}" disagrees with derived "${conflict.derivedStatus}" — review if your intent is stale.`,
    );
    headline = `Manual "${conflict.manualStatus}" disagrees with derived "${conflict.derivedStatus}".`;
  }

  return { headline, bullets };
}

/* ---------------- 3. buildAttentionQueue ---------------- */

export interface AttentionInputs {
  snapshot: LifecycleSnapshot;
  conflict?: LifecycleConflict | null;
  executionId: string;
}

/**
 * Pure: build the Attention Queue from a list of (snapshot + conflict)
 * tuples. Returns sorted, severity-tagged AttentionItem[].
 *
 * Sources:
 *   - manual-vs-derived conflict  -> critical (always)
 *   - blocked > 2h               -> high
 *   - failed > 30min              -> critical
 *   - idle > 24h                  -> medium
 *   - manual done but no commit/end-> medium ("is it really done?")
 *   - everything else              -> not in queue
 */
export function buildAttentionQueue(
  inputs: AttentionInputs[],
  nowMs: number = Date.now(),
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const inp of inputs) {
    const item = computeAttentionItem(inp, nowMs);
    if (item) out.push(item);
  }
  // Stable severity order: critical > high > medium > low.
  const rank: Record<AttentionSeverity, number> = {
    critical: 0, high: 1, medium: 2, low: 3,
  };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.executionId.localeCompare(b.executionId));
  return out;
}

function computeAttentionItem(
  inp: AttentionInputs,
  nowMs: number,
): AttentionItem | null {
  const { snapshot, conflict, executionId } = inp;
  const ageMs = snapshot.lastActivityAgeMs;

  // 1. Conflict: always critical.
  if (conflict && conflict.isConflict) {
    return {
      executionId,
      severity: 'critical',
      reason: conflict.label
        ? `Manual "${conflict.manualStatus}" conflicts with derived "${conflict.derivedStatus}".`
        : 'Manual status conflicts with derived state.',
      recommendedAction: 'review-conflict',
      derivedStatus: snapshot.derivedStatus,
      detectedAt: snapshot.computedAt,
    };
  }

  // 2. Failed for a while -> critical.
  if (snapshot.derivedStatus === 'failed' && ageMs != null && ageMs > FAILED_NEEDS_REVIEW_MS) {
    return {
      executionId,
      severity: 'critical',
      reason: `Failed ${Math.round(ageMs / 60_000)} minutes ago and not resolved.`,
      recommendedAction: 'restart-or-abandon',
      derivedStatus: snapshot.derivedStatus,
      detectedAt: snapshot.computedAt,
    };
  }

  // 3. Blocked for a long time -> high.
  if (snapshot.derivedStatus === 'blocked' && ageMs != null && ageMs > BLOCKED_TOO_LONG_MS) {
    return {
      executionId,
      severity: 'high',
      reason: `Blocked for ${Math.round(ageMs / 60_000 / 60)} hours; recent commit but no further activity.`,
      recommendedAction: 'investigate-blocked',
      derivedStatus: snapshot.derivedStatus,
      detectedAt: snapshot.computedAt,
    };
  }

  // 4. Idle for a very long time -> medium ("archive?").
  if (snapshot.derivedStatus === 'idle' && ageMs != null && ageMs > IDLE_TOO_LONG_MS) {
    return {
      executionId,
      severity: 'medium',
      reason: `Idle for ${Math.round(ageMs / 60_000 / 60 / 24)} days — consider archiving.`,
      recommendedAction: 'archive',
      derivedStatus: snapshot.derivedStatus,
      detectedAt: snapshot.computedAt,
    };
  }

  // 5. queued too long -> low ("monitor").
  if (snapshot.derivedStatus === 'queued' && ageMs != null && ageMs > 10 * 60_000) {
    return {
      executionId,
      severity: 'low',
      reason: 'Queued for > 10min with no first activity — possible ingest issue.',
      recommendedAction: 'monitor',
      derivedStatus: snapshot.derivedStatus,
      detectedAt: snapshot.computedAt,
    };
  }

  return null;
}

/* ---------------- 4. computeWorkspaceSummary ---------------- */

export interface WorkspaceSummaryInput {
  /** executionId -> startTime + durationMs + derivedStatus. */
  executions: Array<{
    executionId: string;
    startedAt: string;
    durationMs: number;
    derivedStatus: DerivedLifecycleStatus;
  }>;
  /** executionId -> health score (output of computeHealthScore). */
  health: Array<{ executionId: string; score: LifecycleHealthScore }>;
  /** executionId -> conflict (for conflictCount). */
  conflicts: Array<{ executionId: string; isConflict: boolean }>;
}

/**
 * Pure: aggregate WorkspaceHealthSummary from per-execution data.
 */
export function computeWorkspaceSummary(input: WorkspaceSummaryInput): WorkspaceHealthSummary {
  const healthById = new Map(input.health.map((h) => [h.executionId, h.score]));
  const conflictById = new Map(input.conflicts.map((c) => [c.executionId, c.isConflict]));

  let healthy = 0;
  let warning = 0;
  let critical = 0;
  let conflictCount = 0;
  let longest: WorkspaceHealthSummary['longestRunning'] = null;

  for (const e of input.executions) {
    const h = healthById.get(e.executionId);
    if (h) {
      if (h.level === 'healthy') healthy++;
      else if (h.level === 'warning') warning++;
      else critical++;
    }
    if (conflictById.get(e.executionId)) conflictCount++;

    // longest running/active (not completed/failed)
    if (e.derivedStatus === 'running' || e.derivedStatus === 'idle' || e.derivedStatus === 'blocked') {
      if (longest === null || e.durationMs > longest.durationMs) {
        longest = {
          executionId: e.executionId,
          startedAt: e.startedAt,
          durationMs: e.durationMs,
          derivedStatus: e.derivedStatus,
        };
      }
    }
  }

  return {
    healthy,
    warning,
    critical,
    conflictCount,
    longestRunning: longest,
    total: input.executions.length,
    computedAt: new Date().toISOString(),
  };
}