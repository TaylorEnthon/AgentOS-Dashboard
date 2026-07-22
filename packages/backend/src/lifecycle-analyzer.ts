/**
 * v1.1 Agent Lifecycle Intelligence Foundation — pure projection.
 *
 * Given the events / commits / usage / timestamps that an Execution
 * is already composed of, derive a richer lifecycle vocabulary than
 * v0.8's three-state `ExecutionStatus`. Six states:
 *
 *   queued      → events present but ALL are tool-calls with no
 *                  assistant messages yet (agent still warming up)
 *   running     → last activity < ACTIVE_THRESHOLD, no failure
 *   idle        → activity 30s..5min old, no recent commits
 *   blocked     → activity > 5min old WHILE recent commits landed
 *                  (the agent committed something but went silent —
 *                  often means it errored out after a commit)
 *   completed   → end_time set, no recent activity, has commits
 *   failed      → a `session-failed` or `error` event type appears
 *                  in the window
 *
 * Module is pure (no DB, no clock side-effects). All thresholds are
 * exposed as parameters so the tests can drive edge cases.
 *
 * Crucially: this module does NOT write to any table. The
 * `shouldRecordAutoTransition` helper at the bottom is for future
 * use; v1.1 has no scheduler / daemon to call it.
 */

import type {
  DerivedLifecycleStatus,
  GitCommitInfo,
  LifecycleConfidence,
  LifecycleIndicator,
  LifecycleSnapshot,
  TimelineItem,
} from '@agentos/shared';

/** Last activity within this → running. */
export const ACTIVE_THRESHOLD_MS = 30 * 1000;

/** Last activity within this → idle (not blocked yet). */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** Last activity within this → blocked (only if recent commits landed). */
export const BLOCKED_THRESHOLD_MS = 30 * 60 * 1000;

export interface LifecycleInputs {
  /** Event timestamps in chronological order (ascending). */
  events: TimelineItem[];
  /** Commits whose timestamp falls in the execution window. */
  commits: GitCommitInfo[];
  /** ISO timestamp from the Session row — when the agent declared "start". */
  startTime: string;
  /** ISO timestamp from the Session row — when the agent declared "end". */
  endTime?: string | null;
  /** When the caller is asking. Defaults to `Date.now()`; injectable for tests. */
  nowMs?: number;
}

/**
 * Run the lifecycle analysis. Always returns a snapshot — even with
 * zero data. Pure: same inputs ⇒ same output.
 */
export function analyzeLifecycle(
  executionId: string,
  inputs: LifecycleInputs,
): LifecycleSnapshot {
  const now = inputs.nowMs ?? Date.now();
  const indicators: LifecycleIndicator[] = [];

  // -- 1. Aggregate signals from inputs ------------------------------

  const lastEvent = inputs.events.length > 0
    ? inputs.events[inputs.events.length - 1]!
    : null;
  const lastEventMs = lastEvent ? Date.parse(lastEvent.timestamp) : null;

  const lastCommit = inputs.commits.length > 0
    ? inputs.commits.reduce((a, b) =>
        Date.parse(a.timestamp) > Date.parse(b.timestamp) ? a : b)
    : null;
  const lastCommitMs = lastCommit ? Date.parse(lastCommit.timestamp) : null;

  const startMs = Date.parse(inputs.startTime);
  const endMs = inputs.endTime ? Date.parse(inputs.endTime) : null;

  // Most recent activity = max(lastEvent, lastCommit, endTime)
  let lastActivityMs: number | null = null;
  for (const candidate of [lastEventMs, lastCommitMs, endMs]) {
    if (candidate == null || !Number.isFinite(candidate)) continue;
    if (lastActivityMs === null || candidate > lastActivityMs) {
      lastActivityMs = candidate;
    }
  }

  const lastActivityAt = lastActivityMs != null
    ? new Date(lastActivityMs).toISOString()
    : null;
  const lastActivityAgeMs = lastActivityMs != null
    ? Math.max(0, now - lastActivityMs)
    : null;

  // -- 2. Failure / queued markers -----------------------------------

  const hasFailureMarker = inputs.events.some((e) =>
    e.type === 'session-end' && /fail|error|abort/i.test(e.detail ?? ''),
  );
  // Other failure event-types could exist; 'status' with failure detail
  // is a broad fallback.
  const hasHardFailureEvent = inputs.events.some((e) =>
    e.type === 'session-end' && /fail|abort/i.test(e.detail ?? ''),
  );

  // Queued: have events but only tool/file ops, no assistant message yet,
  // AND the first event is < 5min old.
  const hasAssistantMessage = inputs.events.some((e) => e.type === 'message');
  const onlyToolOps = inputs.events.length > 0
    && !hasAssistantMessage
    && inputs.events.every((e) =>
      e.type === 'tool-call' || e.type === 'file-read' || e.type === 'command',
    );
  const veryFresh = lastEventMs != null && (now - lastEventMs) < 5 * 60 * 1000;
  const isQueued = onlyToolOps && veryFresh && lastEventMs! - startMs < 5 * 60 * 1000;

  // -- 3. Decision tree -----------------------------------------------
  //
  // Order matters:
  //   1. queued          (no activity yet)
  //   2. failed          (explicit failure marker)
  //   3. completed       (end_time set + now past it)
  //   4. running         (last EVENT age <= ACTIVE)
  //   5. blocked         (last EVENT age > IDLE, AND recent commit)
  //   6. idle            (recent but not active, OR old with no commits)
  //
  // The "blocked" check uses lastEventAge (NOT lastActivityAge) so that
  // a recent commit doesn't push the execution out of the blocked zone.

  const lastEventAgeMs = lastEventMs != null ? now - lastEventMs : null;

  let derivedStatus: DerivedLifecycleStatus;
  let reason: string;

  if (hasFailureMarker || hasHardFailureEvent) {
    derivedStatus = 'failed';
    reason = 'Detected session-end with failure/error detail.';
  } else if (inputs.events.length === 0 && inputs.commits.length === 0 && endMs == null) {
    derivedStatus = 'queued';
    reason = 'No activity yet — session declared start but nothing has happened.';
  } else if (isQueued) {
    derivedStatus = 'queued';
    reason = 'Only tool/file ops so far and last activity < 5min — agent still warming up.';
  } else if (endMs != null && now >= endMs) {
    derivedStatus = 'completed';
    reason = inputs.commits.length > 0
      ? `Session declared end and ${inputs.commits.length} commit${inputs.commits.length === 1 ? '' : 's'} landed.`
      : 'Session declared end.';
  } else if (lastEventAgeMs == null) {
    // Had events in past but timestamps unparseable — best we can do.
    derivedStatus = 'idle';
    reason = 'No parseable event timestamps; defaulting to idle.';
  } else if (lastEventAgeMs <= ACTIVE_THRESHOLD_MS) {
    derivedStatus = 'running';
    reason = `Last event ${Math.round(lastEventAgeMs / 1000)}s ago — well within the active window.`;
  } else if (
    lastEventAgeMs > IDLE_THRESHOLD_MS
    && lastCommitMs != null
    && (now - lastCommitMs) < 15 * 60 * 1000
  ) {
    derivedStatus = 'blocked';
    reason = 'Last event > 5min ago but a commit landed in the last 15min — agent may be stuck after commit.';
  } else {
    derivedStatus = 'idle';
    const mins = Math.round(lastEventAgeMs / 1000 / 60);
    reason = `Last event ${mins}min ago; no recent commits and no failure markers.`;
  }

  // -- 4. Indicators (evidence trail) ---------------------------------

  if (inputs.events.length === 0 && inputs.commits.length === 0) {
    indicators.push({ type: 'empty-data', label: 'No events and no commits recorded', weight: 1 });
  }
  if (lastEventMs != null) {
    const ageS = Math.round((now - lastEventMs) / 1000);
    if (ageS <= ACTIVE_THRESHOLD_MS / 1000) {
      indicators.push({ type: 'recent-activity', label: `Last event ${ageS}s ago`, weight: 1 });
    } else if (ageS <= IDLE_THRESHOLD_MS / 1000) {
      indicators.push({ type: 'idle-threshold-crossed', label: `Last event ${ageS}s ago (>30s)`, weight: 0.7 });
    } else {
      indicators.push({ type: 'no-activity', label: `Last event ${ageS}s ago (>5min)`, weight: 0.6 });
    }
  }
  if (inputs.commits.length > 0) {
    const ageS = lastCommitMs != null ? Math.round((now - lastCommitMs) / 1000) : -1;
    indicators.push({
      type: 'commit-landed',
      label: `${inputs.commits.length} commit${inputs.commits.length === 1 ? '' : 's'} in window${
        ageS >= 0 ? `; last ${ageS}s ago` : ''
      }`,
      weight: 0.8,
    });
    if (derivedStatus === 'blocked' && ageS < 15 * 60) {
      indicators.push({ type: 'blocked-threshold-crossed', label: 'Recent commit + silent for >5min', weight: 1 });
    }
  }
  if (endMs != null) {
    indicators.push({ type: 'session-ended', label: `Session end time set`, weight: 1 });
  }
  if (hasFailureMarker || hasHardFailureEvent) {
    indicators.push({ type: 'failure-marker', label: 'Session-end event contains failure/error detail', weight: 1 });
  }
  // "contradiction" indicator only when we have events but no messages yet
  // (the isQueued case). Empty data gets the empty-data indicator only.
  if (derivedStatus === 'queued' && isQueued) {
    indicators.push({
      type: 'contradiction',
      label: 'Events present but no assistant message yet (only tool/file ops)',
      weight: 0.7,
    });
  }

  // -- 5. Confidence ---------------------------------------------------

  let confidence: LifecycleConfidence;
  // empty-data alone is always low (we have no real evidence).
  const onlyEmptyData = indicators.length === 1 && indicators[0]!.type === 'empty-data';
  if (indicators.length === 0 || onlyEmptyData) {
    confidence = 'low';
  } else if (
    indicators.some((i) => i.weight >= 1)
    && indicators.filter((i) => i.weight >= 0.7).length >= 2
  ) {
    confidence = 'high';
  } else if (indicators.some((i) => i.weight >= 1)) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    executionId,
    derivedStatus,
    confidence,
    reason,
    lastActivityAt,
    lastActivityAgeMs,
    indicators,
    computedAt: new Date(now).toISOString(),
  };
}

/* ---------------- Auto history transition helper ----------------
 *
 * v1.1 does NOT auto-record. The helper below is provided so a
 * future scheduler / daemon can decide "should I insert an 'auto'
 * history row right now?" without re-implementing the rules.
 *
 * Rules:
 *   - Never write when `prev` and `curr` have the same `derivedStatus`.
 *   - Never write when the new snapshot's confidence is `low`
 *     (don't pollute the manual timeline with guesses).
 *   - Never write within AUTO_DEDUPE_MS of the last auto row, even
 *     if the status changed (prevents thrashing).
 */

export const AUTO_DEDUPE_MS = 5 * 60 * 1000; // 5 minutes

export interface PrevAutoRow {
  toStatus: LifecycleSnapshot['derivedStatus'];
  createdAt: string; // ISO
}

export interface AutoTransitionDecision {
  shouldWrite: boolean;
  reason: string;
}

/**
 * Pure decision: "given the previous auto row + current snapshot,
 * should I insert a new auto history row?"
 */
export function shouldRecordAutoTransition(
  prev: PrevAutoRow | null,
  curr: LifecycleSnapshot,
  nowMs: number = Date.now(),
): AutoTransitionDecision {
  if (curr.confidence === 'low') {
    return { shouldWrite: false, reason: 'confidence is low — skipping auto write' };
  }
  if (prev && prev.toStatus === curr.derivedStatus) {
    return { shouldWrite: false, reason: 'same status as previous auto row' };
  }
  if (prev) {
    const prevMs = Date.parse(prev.createdAt);
    if (Number.isFinite(prevMs) && nowMs - prevMs < AUTO_DEDUPE_MS) {
      return { shouldWrite: false, reason: `within AUTO_DEDUPE_MS (${AUTO_DEDUPE_MS}ms) window` };
    }
  }
  return { shouldWrite: true, reason: `transition ${prev?.toStatus ?? '∅'} → ${curr.derivedStatus}` };
}