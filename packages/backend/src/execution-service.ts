/**
 * v0.8 Execution Intelligence — pure projection over Session data.
 *
 * An "Execution" is one logical task within a Session. It is derived,
 * not stored. The grouping rule is intentionally simple so v0.8 ships
 * something that can be improved later:
 *
 *   Two events belong to the same Execution if their timestamps are
 *   within `GAP_MS` of each other (default 30 minutes). A larger gap
 *   starts a new Execution.
 *
 * Why this rule (and not "git commit boundaries" or "tool-call clusters"):
 *  - It's deterministic and easy to explain in the UI.
 *  - It works even when the agent makes no commits (which is common
 *    when the task is exploration / analysis).
 *  - 30 min is long enough to span "the agent went off, fetched a file,
 *    thought, came back" but short enough that a real task boundary
 *    (lunch break, context restart) triggers a split.
 *
 * Git commits whose timestamp falls inside `[startTime, endTime]` are
 * associated with the Execution via the same `commitsInRange` helper
 * the Session detail page already uses. We deliberately do NOT split
 * an Execution at a commit boundary in v0.8 — commits are a side
 * effect of an Execution, not a synonym for one.
 */

import type {
  AgentExecution,
  AgentType,
  ExecutionStatus,
  GitCommitInfo,
  TimelineItem,
  UsageRecord,
} from '@agentos/shared';

/** Default gap threshold: 30 minutes. Tunable per-call for tests. */
export const DEFAULT_EXECUTION_GAP_MS = 30 * 60 * 1000;

/** "Still running" window: last activity within this many ms → status=running. */
export const EXECUTION_ACTIVE_THRESHOLD_MS = 30 * 1000;

export interface ExecutionGroup {
  /** Zero-based index of this group within its session. */
  index: number;
  /** Events in chronological order (oldest first). */
  events: TimelineItem[];
  startTime: string;
  endTime: string;
}

/**
 * Split a chronologically-sorted list of events into Execution groups.
 * Assumes `events` is sorted ascending by timestamp. The 30-minute gap
 * rule is applied between consecutive events.
 *
 * Edge cases:
 *  - empty input → []
 *  - single event → one group
 *  - events with the same timestamp → always same group
 *  - events with non-monotonic timestamps → still grouped by gap (the
 *    caller should pre-sort; this function does not re-sort to keep
 *    semantics predictable for tests).
 */
export function groupEventsIntoExecutions(
  events: TimelineItem[],
  gapMs: number = DEFAULT_EXECUTION_GAP_MS,
): ExecutionGroup[] {
  if (events.length === 0) return [];
  const groups: ExecutionGroup[] = [];
  let current: TimelineItem[] = [events[0]!];

  const flush = (): void => {
    if (current.length === 0) return;
    groups.push({
      index: groups.length,
      events: current,
      startTime: current[0]!.timestamp,
      endTime: current[current.length - 1]!.timestamp,
    });
    current = [];
  };

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    const dt = Date.parse(cur.timestamp) - Date.parse(prev.timestamp);
    if (Number.isFinite(dt) && dt > gapMs) {
      flush();
    }
    current.push(cur);
  }
  flush();
  return groups;
}

/**
 * Derive the best human-readable title for an Execution.
 * Priority: session.displayName → session.title → first non-empty
 * event detail → first event type label.
 */
export function inferExecutionTitle(
  events: TimelineItem[],
  sessionDisplayName?: string | null,
  sessionTitle?: string | null,
): string | undefined {
  if (sessionDisplayName && sessionDisplayName.trim()) return sessionDisplayName.trim();
  if (sessionTitle && sessionTitle.trim()) return sessionTitle.trim();
  for (const e of events) {
    if (e.detail && e.detail.trim()) return e.detail.trim().slice(0, 120);
  }
  if (events.length > 0) return events[0]!.type;
  return undefined;
}

/**
 * Pick which git commits belong to this Execution's time window.
 * Window rule: a commit belongs to group G if its timestamp falls in
 * `[G.startTime, G.endTime + grace)` — where `grace` is
 * `DEFAULT_EXECUTION_GAP_MS` for the last group, OR the gap to the
 * next group's `startTime` for any other group (whichever is smaller).
 *
 * Why this matters: an agent often commits a few seconds AFTER its
 * last recorded activity_event. Without grace, single-event groups
 * would have a zero-duration window and never associate with the
 * commits that immediately follow them.
 */
export function associateCommitsToExecutions(
  groups: ExecutionGroup[],
  commits: GitCommitInfo[],
  graceMs: number = DEFAULT_EXECUTION_GAP_MS,
): Map<number, GitCommitInfo[]> {
  const out = new Map<number, GitCommitInfo[]>();
  if (groups.length === 0) return out;
  for (const c of commits) {
    const t = Date.parse(c.timestamp);
    if (!Number.isFinite(t)) continue;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      const s = Date.parse(g.startTime);
      const e = Date.parse(g.endTime);
      const next = groups[i + 1];
      const nextStart = next ? Date.parse(next.startTime) : Number.POSITIVE_INFINITY;
      const capByNext = nextStart - e; // gap to next group (ms)
      const cap = Math.min(graceMs, Number.isFinite(capByNext) && capByNext >= 0 ? capByNext : graceMs);
      const endExclusive = e + cap;
      if (t >= s && t < endExclusive) {
        const bucket = out.get(g.index) ?? [];
        bucket.push(c);
        out.set(g.index, bucket);
        break;
      }
    }
  }
  return out;
}

/**
 * Pick which usage records belong to each Execution's time window.
 * Same window rule as commits: `[G.startTime, G.endTime + grace)`.
 */
export function associateUsageToExecutions(
  groups: ExecutionGroup[],
  usage: UsageRecord[],
  graceMs: number = DEFAULT_EXECUTION_GAP_MS,
): Map<number, UsageRecord[]> {
  const out = new Map<number, UsageRecord[]>();
  if (groups.length === 0) return out;
  for (const u of usage) {
    const t = Date.parse(u.timestamp);
    if (!Number.isFinite(t)) continue;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      const s = Date.parse(g.startTime);
      const e = Date.parse(g.endTime);
      const next = groups[i + 1];
      const nextStart = next ? Date.parse(next.startTime) : Number.POSITIVE_INFINITY;
      const capByNext = nextStart - e;
      const cap = Math.min(graceMs, Number.isFinite(capByNext) && capByNext >= 0 ? capByNext : graceMs);
      const endExclusive = e + cap;
      if (t >= s && t < endExclusive) {
        const bucket = out.get(g.index) ?? [];
        bucket.push(u);
        out.set(g.index, bucket);
        break;
      }
    }
  }
  return out;
}

/**
 * Roll up a UsageRecord list into (tokens, cost).
 * Defensive: skips rows with NaN/non-finite numbers.
 */
export function sumUsage(records: UsageRecord[]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const r of records) {
    if (Number.isFinite(r.totalTokens)) tokens += r.totalTokens;
    if (Number.isFinite(r.estimatedCost)) cost += r.estimatedCost;
  }
  return { tokens, cost };
}

/**
 * Decide an Execution's status:
 *   - running:   last event within EXECUTION_ACTIVE_THRESHOLD_MS of `now`
 *                AND no commits yet (commits are evidence of completion)
 *   - completed: has any associated commit OR session end_time set
 *                AND last event older than the active threshold
 *   - unknown:   anything else (last activity is old but no commit, no end)
 */
export function deriveExecutionStatus(
  group: ExecutionGroup,
  hasCommits: boolean,
  nowMs: number = Date.now(),
): ExecutionStatus {
  const lastTs = Date.parse(group.endTime);
  if (Number.isNaN(lastTs)) return 'unknown';
  const ageMs = nowMs - lastTs;
  if (ageMs <= EXECUTION_ACTIVE_THRESHOLD_MS && !hasCommits) return 'running';
  if (hasCommits) return 'completed';
  // Has activity but is "stale" and has no commits — treat as completed
  // only when the gap is comfortably above the active threshold.
  // Otherwise the user is probably actively typing and we just missed
  // the last event; keep `unknown` so the UI doesn't claim victory too soon.
  return ageMs > EXECUTION_ACTIVE_THRESHOLD_MS ? 'completed' : 'unknown';
}

/**
 * Build the public AgentExecution shape from a group + session context.
 * No DB access; pure function over already-fetched data.
 */
export function buildExecution(
  sessionId: string,
  agentId: string,
  agentType: AgentType,
  project: string,
  projectDisplay: string,
  group: ExecutionGroup,
  commits: GitCommitInfo[],
  usageRecords: UsageRecord[],
  nowMs: number = Date.now(),
): AgentExecution {
  const startMs = Date.parse(group.startTime);
  const endMs = Date.parse(group.endTime);
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : 0;
  const { tokens, cost } = sumUsage(usageRecords);
  return {
    id: `${sessionId}:exec-${group.index}`,
    sessionId,
    agentId,
    agentType,
    project,
    projectDisplay,
    title: inferExecutionTitle(group.events),
    startTime: group.startTime,
    endTime: group.endTime,
    durationMs,
    eventCount: group.events.length,
    tokenUsage: tokens,
    cost,
    commits,
    status: deriveExecutionStatus(group, commits.length > 0, nowMs),
  };
}