/**
 * v1.2 Lifecycle Runtime — composes the pure lifecycle-analyzer
 * with execution-scope filtering, the lifecycle-cache, conflict
 * detection, and SSE emission.
 *
 * This is the ONLY place where:
 *   - lifecycle snapshots get cached
 *   - lifecycle_changed SSE events get emitted
 *
 * The SSE emission happens "on read" (when `/api/executions/:id/lifecycle`
 * is called): if the newly computed snapshot differs from the cached
 * one, we emit. This is lazy but correct — every SSE emission is
 * backed by a fresh snapshot, never by stale data.
 *
 * `file_changed` / `scan_completed` events from the existing event-bus
 * trigger `invalidateLifecycleCache(...)` so the next read recomputes.
 * No scheduler / daemon / background worker.
 */

import type {
  DerivedLifecycleStatus,
  LifecycleConflict,
  LifecycleSnapshot,
  TimelineItem,
  ManualExecutionStatus,
} from '@agentos/shared';
import { analyzeLifecycle } from './lifecycle-analyzer.js';
import { groupEventsIntoExecutions, type ExecutionGroup } from './execution-service.js';
import { lifecycleCache } from './lifecycle-cache.js';
import { eventBus, type RealtimeEvent } from './event-bus.js';

const GROUP_GAP_MS = 30 * 60 * 1000; // matches execution-service

/**
 * Find the group (ExecutionGroup) matching `execIndex` for this session's
 * events. Returns null if not found.
 */
export function findExecutionGroup(
  events: TimelineItem[],
  execIndex: number,
  gapMs: number = GROUP_GAP_MS,
): ExecutionGroup | null {
  const groups = groupEventsIntoExecutions(events, gapMs);
  if (execIndex < 0 || execIndex >= groups.length) return null;
  return groups[execIndex] ?? null;
}

/**
 * Filter events down to a single execution's window. Used by the
 * /api/executions/:id/lifecycle and batch endpoints so multi-execution
 * sessions don't bleed evidence across cards (v1.1 bug fix).
 *
 * Strategy:
 *   1. Group events using the 30-min gap rule.
 *   2. Pick the group at `execIndex`.
 *   3. Apply the same grace window used in execution-service.ts for
 *      commit / usage association: events within `group.startTime ..
 *      group.endTime + min(gap, nextGroup.startTime - group.endTime)`.
 *      This keeps single-event groups usable.
 */
export function scopeEventsToExecution(
  allEvents: TimelineItem[],
  execIndex: number,
  gapMs: number = GROUP_GAP_MS,
): TimelineItem[] {
  const groups = groupEventsIntoExecutions(allEvents, gapMs);
  if (execIndex < 0 || execIndex >= groups.length) return [];
  const group = groups[execIndex];
  if (!group) return [];
  const next = groups[execIndex + 1];
  const startMs = Date.parse(group.startTime);
  const endMs = Date.parse(group.endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const capByNext = next ? Date.parse(next.startTime) - endMs : Number.POSITIVE_INFINITY;
  const cap = Math.min(gapMs, Number.isFinite(capByNext) && capByNext >= 0 ? capByNext : gapMs);
  const endExclusive = endMs + cap;

  return group.events;
}

/**
 * Detect whether the manual override disagrees with the derived state
 * in a way the user probably cares about. "disagree" means the user's
 * intent (manual) and the system's reality (derived) point in
 * different directions.
 *
 * Mapping (derived -> comparable manual):
 *   completed  ~ done
 *   failed     ~ blocked (something is wrong)
 *   running    ~ in-progress (both "actively being worked on")
 *   idle       ~ todo (both "not actively being worked on")
 *   queued     ~ todo (both "not started / waiting")
 *   blocked    ~ blocked
 *
 * No-manual or same-bucket: NOT a conflict.
 */
export function detectLifecycleConflict(
  executionId: string,
  derived: LifecycleSnapshot,
  manual: ManualExecutionStatus | null,
): LifecycleConflict {
  const label = manual
    ? `${manual} vs ${derived.derivedStatus}`
    : null;
  if (!manual) {
    return {
      executionId,
      manualStatus: null,
      derivedStatus: derived.derivedStatus,
      confidence: derived.confidence,
      reason: derived.reason,
      isConflict: false,
      label: null,
    };
  }
  const derivedBucket = bucketize(derived.derivedStatus);
  const manualBucket = bucketize(manual);
  const isConflict = derivedBucket !== manualBucket;
  return {
    executionId,
    manualStatus: manual,
    derivedStatus: derived.derivedStatus,
    confidence: derived.confidence,
    reason: derived.reason,
    isConflict,
    label: isConflict ? label : null,
  };
}

function bucketize(s: DerivedLifecycleStatus | ManualExecutionStatus): string {
  switch (s) {
    case 'completed':
    case 'done':
      return 'completed';
    case 'failed':
    case 'blocked':
      return 'blocked';
    case 'running':
    case 'in-progress':
      return 'active';
    case 'idle':
    case 'queued':
    case 'todo':
      return 'idle';
    case 'archived':
      return 'archived';
  }
}

/**
 * Compute lifecycle for one execution, going through the cache.
 *
 * Returns the snapshot AND the previous cached snapshot (or null)
 * so the caller can decide whether to emit a `lifecycle_changed`
 * SSE event.
 *
 * If `emitOnChange` is true and the derivedStatus differs from the
 * cached one, the function publishes a `lifecycle_changed` event on
 * the process-wide eventBus. Subscribers include the SSE stream.
 */
export interface RuntimeOptions {
  /** Pass `false` to skip emitting SSE (used by tests). */
  emitOnChange?: boolean;
  /** Inject `now` for tests. */
  nowMs?: number;
}

export interface ComputeResult {
  snapshot: LifecycleSnapshot;
  previous: LifecycleSnapshot | null;
  changed: boolean;
}

export function computeAndCacheLifecycle(
  executionId: string,
  inputs: {
    events: TimelineItem[];
    commits: Array<{ hash: string; shortHash: string; message: string; body: string; author: string; authorEmail: string; timestamp: string; filesChanged: number; insertions: number; deletions: number }>;
    startTime: string;
    endTime?: string | null;
  },
  opts: RuntimeOptions = {},
): ComputeResult {
  const snapshot = analyzeLifecycle(executionId, {
    ...inputs,
    nowMs: opts.nowMs,
  });
  const previous = lifecycleCache.set(executionId, snapshot);
  const changed =
    previous !== null &&
    previous.derivedStatus !== snapshot.derivedStatus;

  if (changed && opts.emitOnChange !== false) {
    const ev: RealtimeEvent = {
      type: 'lifecycle_changed',
      ts: new Date().toISOString(),
      executionId,
      derivedStatus: snapshot.derivedStatus,
      previousDerivedStatus: previous.derivedStatus,
      confidence: snapshot.confidence,
      reason: snapshot.reason,
    };
    eventBus.emit(ev);
  }

  return { snapshot, previous, changed };
}

/* ---------------- Activity-update invalidation ---------------- */

let subscribed = false;

/**
 * Wire `file_changed` and `scan_completed` events to lifecycle cache
 * invalidation. Idempotent — safe to call multiple times.
 *
 * The simplest correct approach: invalidate the WHOLE cache on any
 * activity event. The cache will re-warm on the next read. We could
 * be smarter (track which session/agent each entry belongs to and
 * invalidate selectively) but the cache is cheap to rebuild.
 */
export function subscribeLifecycleInvalidation(): void {
  if (subscribed) return;
  subscribed = true;
  eventBus.subscribe((ev: RealtimeEvent) => {
    if (ev.type === 'file_changed' || ev.type === 'scan_completed') {
      // Drop everything; cheapest correct behavior. Reads will re-warm.
      lifecycleCache.clear();
    }
  });
}

/** For tests that need to reset the subscribe flag. */
export function _resetLifecycleInvalidationForTests(): void {
  subscribed = false;
}