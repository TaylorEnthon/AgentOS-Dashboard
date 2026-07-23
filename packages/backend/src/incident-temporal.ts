/**
 * v1.10: Incident Temporal Intelligence — pure-function module.
 *
 * Adds time-windowed aggregation, trend detection, and rule-based
 * intelligence signals on top of HealthIncident[].
 *
 *   - filterIncidentsByWindow  — half-open [since, until) filter on detectedAt
 *   - summarizeWindow           — workspace-level temporal snapshot
 *   - buildAgentTrend           — single agent's trend vs previous window
 *   - buildAllAgentTrends        — workspace trends for all affected agents
 *   - detectBurst                — same-kind spike in short window
 *   - detectAgentDegradation     — multiple executions of one agent degraded
 *   - detectIntelligenceSignals  — combined signal detector
 *
 * All functions are pure: same input → same output, no DB writes,
 * no external services. Deterministic.
 *
 * Time convention: `detectedAt` is the incident's birth time;
 * `lastTransitionAt` is the most recent activity timestamp. Window
 * membership is decided by `detectedAt`.
 */

import type {
  AgentIncidentInsight,
  AgentReliabilityTrend,
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentTemporalSummary,
  IntelligenceSignal,
  IntelligenceSignalKind,
  IntelligenceSignalSeverity,
  IntelligenceSignalSummary,
  TrendDirection,
} from '@agentos/shared';

/* ---------------- constants ---------------- */

const DEFAULT_BURST_THRESHOLD = 3;             // ≥3 same-kind incidents → burst signal
const DEFAULT_BURST_WINDOW_MS = 60 * 60_000;   // 1 hour
const DEFAULT_AGENT_DEGRADATION_THRESHOLD = 3; // ≥3 affected executions → degradation signal
const DEFAULT_TREND_CHANGE_THRESHOLD = 0.20;  // ±20% change counts as direction

/* ---------------- helpers ---------------- */

function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function withinWindow(inc: HealthIncident, sinceMs: number, untilMs: number): boolean {
  const t = parseTs(inc.detectedAt);
  if (!Number.isFinite(t)) return false;
  // Half-open: from inclusive, to exclusive.
  return t >= sinceMs && t < untilMs;
}

/* ---------------- 1. time-window filter ---------------- */

/**
 * Pure filter: returns incidents whose `detectedAt` falls in
 * `[sinceIso, untilIso)` (half-open). Either bound may be omitted:
 *   - no since → open on the past
 *   - no until → open on the future
 *
 * Deterministic; no DB writes.
 */
export function filterIncidentsByWindow(
  incidents: HealthIncident[],
  opts: { sinceIso?: string; untilIso?: string } = {},
): HealthIncident[] {
  const sinceMs = opts.sinceIso ? parseTs(opts.sinceIso) : Number.NEGATIVE_INFINITY;
  const untilMs = opts.untilIso ? parseTs(opts.untilIso) : Number.POSITIVE_INFINITY;
  return incidents.filter((inc) => {
    const t = parseTs(inc.detectedAt);
    if (!Number.isFinite(t)) return false;
    return t >= sinceMs && t < untilMs;
  });
}

/* ---------------- 2. workspace temporal summary ---------------- */

/**
 * Build a workspace-level temporal snapshot over a time window.
 * Pure / read-only / deterministic.
 */
export function summarizeWindow(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: { sinceIso: string; untilIso: string; nowMs?: number } = { sinceIso: '1970-01-01T00:00:00.000Z', untilIso: '9999-12-31T23:59:59.999Z' },
): IncidentTemporalSummary {
  const sinceMs = parseTs(opts.sinceIso);
  const untilMs = parseTs(opts.untilIso);
  const computedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  const windowMs = Math.max(0, untilMs - sinceMs);
  const inWindow = incidents.filter((inc) => withinWindow(inc, sinceMs, untilMs));
  let activeCount = 0, recoveredCount = 0;
  let criticalCount = 0, highCount = 0;
  const byKindMap = new Map<HealthAnomalyKind, number>();
  const byAgentMap = new Map<string, number>();
  for (const inc of inWindow) {
    if (inc.lifecycle === 'recovered') recoveredCount++;
    else activeCount++;
    if (inc.severity === 'critical') criticalCount++;
    else highCount++;
    byKindMap.set(inc.kind, (byKindMap.get(inc.kind) ?? 0) + 1);
    const agent = executionToAgent.get(inc.executionId);
    if (agent) byAgentMap.set(agent, (byAgentMap.get(agent) ?? 0) + 1);
  }
  const densityPerHour = windowMs > 0 ? (inWindow.length / windowMs) * 3_600_000 : 0;
  const byKind = Array.from(byKindMap.entries())
    .map(([kind, incidentCount]) => ({ kind, incidentCount }))
    .sort((a, b) => b.incidentCount - a.incidentCount || a.kind.localeCompare(b.kind));
  const byAgent = Array.from(byAgentMap.entries())
    .map(([agentType, incidentCount]) => ({ agentType, incidentCount }))
    .sort((a, b) => b.incidentCount - a.incidentCount || a.agentType.localeCompare(a.agentType));
  return {
    since: opts.sinceIso,
    until: opts.untilIso,
    windowMs,
    incidentCount: inWindow.length,
    activeCount,
    recoveredCount,
    criticalCount,
    highCount,
    severityDistribution: { critical: criticalCount, high: highCount },
    byKind,
    byAgent,
    densityPerHour,
    computedAt,
  };
}

/* ---------------- 3. per-agent trend ---------------- */

/**
 * Build a single agent's reliability trend over [sinceIso, untilIso),
 * comparing it against the immediately preceding window of the same
 * duration.
 *
 * Trend direction logic (deterministic, explainable):
 *   - 'no-data'    if current window incidentCount === 0 AND previous window incidentCount === 0
 *   - 'improving'  if current < previous AND current active ≤ previous active
 *                     (or current < previous by ≥ trendChangeThreshold)
 *   - 'degrading'  if current > previous by ≥ trendChangeThreshold
 *                     OR current critical > previous critical
 *   - 'stable'     otherwise (within ±trendChangeThreshold)
 *
 * Pure / read-only / deterministic.
 */
export function buildAgentTrend(
  agentType: string,
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: {
    sinceIso: string;
    untilIso: string;
    nowMs?: number;
    trendChangeThreshold?: number;
    rankByIncidentCount?: number | null;
  } = { sinceIso: '1970-01-01T00:00:00.000Z', untilIso: '9999-12-31T23:59:59.999Z' },
): AgentReliabilityTrend {
  const sinceMs = parseTs(opts.sinceIso);
  const untilMs = parseTs(opts.untilIso);
  const windowMs = Math.max(0, untilMs - sinceMs);
  const previousSinceMs = sinceMs - windowMs;
  const previousUntilMs = sinceMs;
  const threshold = opts.trendChangeThreshold ?? DEFAULT_TREND_CHANGE_THRESHOLD;

  // Filter incidents to this agent (by execToAgent lookup).
  const agentIncidents = incidents.filter((inc) => executionToAgent.get(inc.executionId) === agentType);
  const current = agentIncidents.filter((inc) => withinWindow(inc, sinceMs, untilMs));
  const previous = agentIncidents.filter((inc) => withinWindow(inc, previousSinceMs, previousUntilMs));

  const summary = (list: HealthIncident[]) => {
    const execs = new Set<string>();
    let active = 0, recovered = 0, critical = 0, high = 0;
    let totalEscalations = 0;
    let worst: HealthAnomalySeverity = 'high';
    for (const inc of list) {
      execs.add(inc.executionId);
      if (inc.lifecycle === 'recovered') recovered++;
      else active++;
      if (inc.severity === 'critical') { worst = 'critical'; critical++; }
      else high++;
      totalEscalations += inc.escalationCount;
    }
    return {
      executionCount: execs.size,
      activeCount: active,
      recoveredCount: recovered,
      criticalCount: critical,
      highCount: high,
      totalEscalations,
      worstSeverity: worst,
      incidentCount: list.length,
      affectedExecutions: execs.size,
    };
  };
  const cur = summary(current);
  const prev = summary(previous);

  const incidentDelta = cur.incidentCount - prev.incidentCount;
  const criticalDelta = cur.criticalCount - prev.criticalCount;
  const trendDirection = computeTrendDirection(cur, prev, threshold);

  const degradationRate = cur.affectedExecutions > 0
    ? cur.incidentCount / cur.affectedExecutions
    : 0;

  return {
    agentType,
    since: opts.sinceIso,
    until: opts.untilIso,
    windowMs,
    executionCount: cur.executionCount,
    affectedExecutions: cur.affectedExecutions,
    incidentCount: cur.incidentCount,
    activeCount: cur.activeCount,
    recoveredCount: cur.recoveredCount,
    criticalCount: cur.criticalCount,
    highCount: cur.highCount,
    totalEscalations: cur.totalEscalations,
    worstSeverity: cur.worstSeverity,
    degradationRate,
    trendDirection,
    incidentDelta,
    criticalDelta,
    rankByIncidentCount: opts.rankByIncidentCount ?? null,
  };
}

function computeTrendDirection(
  cur: { incidentCount: number; activeCount: number; criticalCount: number },
  prev: { incidentCount: number; activeCount: number; criticalCount: number },
  threshold: number,
): TrendDirection {
  if (cur.incidentCount === 0 && prev.incidentCount === 0) return 'no-data';
  if (prev.incidentCount === 0 && cur.incidentCount > 0) return 'degrading';
  if (cur.incidentCount === 0 && prev.incidentCount > 0) return 'improving';
  const incidentChange = (cur.incidentCount - prev.incidentCount) / Math.max(1, prev.incidentCount);
  const criticalUp = cur.criticalCount > prev.criticalCount;
  if (incidentChange >= threshold || criticalUp) return 'degrading';
  if (incidentChange <= -threshold) return 'improving';
  return 'stable';
}

/**
 * Build trends for every affected agent (one per AgentType with ≥1
 * incident in the current window). Sorted by `incidentCount` desc so
 * the caller can pick top-N "degrading" agents.
 *
 * The `rankByIncidentCount` field is set to the 1-based rank; null
 * if the agent had 0 incidents.
 */
export function buildAllAgentTrends(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: { sinceIso: string; untilIso: string; nowMs?: number; trendChangeThreshold?: number } = {
    sinceIso: '1970-01-01T00:00:00.000Z',
    untilIso: '9999-12-31T23:59:59.999Z',
  },
): AgentReliabilityTrend[] {
  const agentTypes = new Set<string>();
  for (const inc of incidents) {
    const a = executionToAgent.get(inc.executionId);
    if (a) agentTypes.add(a);
  }
  const trends: AgentReliabilityTrend[] = [];
  for (const a of agentTypes) {
    const t = buildAgentTrend(a, incidents, executionToAgent, opts);
    trends.push(t);
  }
  trends.sort((a, b) => b.incidentCount - a.incidentCount || sevRank(b.worstSeverity) - sevRank(a.worstSeverity));
  // Assign rankByIncidentCount after sorting.
  trends.forEach((t, i) => {
    t.rankByIncidentCount = t.incidentCount > 0 ? i + 1 : null;
  });
  return trends;
}

function sevRank(s: HealthAnomalySeverity): number {
  return s === 'critical' ? 2 : 1;
}

/* ---------------- 4. burst detection ---------------- */

/**
 * Pure burst detector: a single HealthAnomalyKind with ≥ `threshold`
 * distinct incidents in [nowMs - windowMs, nowMs).
 *
 * Returns one IntelligenceSignal per qualifying kind. Severity is
 * 'alert' if the burst contains a critical incident, else 'warn'.
 */
export function detectBurst(
  incidents: HealthIncident[],
  opts: {
    nowMs?: number;
    windowMs?: number;
    threshold?: number;
  } = {},
): IntelligenceSignal[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_BURST_WINDOW_MS;
  const threshold = opts.threshold ?? DEFAULT_BURST_THRESHOLD;
  const sinceMs = nowMs - windowMs;
  const recent = incidents.filter((inc) => withinWindow(inc, sinceMs, nowMs));
  const byKind = new Map<HealthAnomalyKind, HealthIncident[]>();
  for (const inc of recent) {
    const arr = byKind.get(inc.kind);
    if (arr) arr.push(inc);
    else byKind.set(inc.kind, [inc]);
  }
  const out: IntelligenceSignal[] = [];
  for (const [kind, list] of byKind.entries()) {
    if (list.length < threshold) continue;
    const hasCritical = list.some((inc) => inc.severity === 'critical');
    const sinceIso = new Date(sinceMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    out.push({
      signalId: `burst:${kind}`,
      kind: 'burst',
      severity: hasCritical ? 'alert' : 'warn',
      subjectKey: kind,
      subjectLabel: kind,
      since: sinceIso,
      until: untilIso,
      score: list.length,
      threshold,
      description: `${list.length} ${kind} incident${list.length === 1 ? '' : 's'} in the last ${Math.round(windowMs / 60_000)}m (threshold ${threshold}).`,
    });
  }
  // Sort by score desc.
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ---------------- 5. agent-wide degradation ---------------- */

/**
 * Pure detector: an agent with ≥ `threshold` distinct executions
 * affected in [nowMs - windowMs, nowMs).
 */
export function detectAgentDegradation(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: {
    nowMs?: number;
    windowMs?: number;
    threshold?: number;
  } = {},
): IntelligenceSignal[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_BURST_WINDOW_MS;
  const threshold = opts.threshold ?? DEFAULT_AGENT_DEGRADATION_THRESHOLD;
  const sinceMs = nowMs - windowMs;
  const recent = incidents.filter((inc) => withinWindow(inc, sinceMs, nowMs));
  const byAgent = new Map<string, HealthIncident[]>();
  for (const inc of recent) {
    const a = executionToAgent.get(inc.executionId);
    if (!a) continue;
    const arr = byAgent.get(a);
    if (arr) arr.push(inc);
    else byAgent.set(a, [inc]);
  }
  const out: IntelligenceSignal[] = [];
  for (const [agent, list] of byAgent.entries()) {
    const execs = new Set(list.map((inc) => inc.executionId));
    if (execs.size < threshold) continue;
    const hasCritical = list.some((inc) => inc.severity === 'critical');
    const sinceIso = new Date(sinceMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    out.push({
      signalId: `agent-degradation:${agent}`,
      kind: 'agent-degradation',
      severity: hasCritical ? 'alert' : 'warn',
      subjectKey: agent,
      subjectLabel: agent,
      since: sinceIso,
      until: untilIso,
      score: execs.size,
      threshold,
      description: `${agent} has incidents across ${execs.size} executions in the last ${Math.round(windowMs / 60_000)}m (threshold ${threshold}).`,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ---------------- 6. combined signal detector ---------------- */

/**
 * Combine burst + agent-degradation + per-agent trend alerts into a
 * single IntelligenceSignalSummary. Sorted by severity desc, then score desc.
 */
export function detectIntelligenceSignals(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: {
    nowMs?: number;
    burstWindowMs?: number;
    burstThreshold?: number;
    agentWindowMs?: number;
    agentThreshold?: number;
  } = {},
): IntelligenceSignalSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const burst = detectBurst(incidents, {
    nowMs,
    windowMs: opts.burstWindowMs,
    threshold: opts.burstThreshold,
  });
  const agentDegradation = detectAgentDegradation(incidents, executionToAgent, {
    nowMs,
    windowMs: opts.agentWindowMs,
    threshold: opts.agentThreshold,
  });
  // Recovery surge: count recoveries in the same window; alert if ≥ 3
  // incidents resolved in a short window (no specific burst here, kept simple).
  const recoverySurge: IntelligenceSignal[] = [];
  const sinceMs = nowMs - (opts.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS);
  const recent = incidents.filter((inc) => withinWindow(inc, sinceMs, nowMs));
  const recoveries = recent.filter((inc) => inc.lifecycle === 'recovered');
  if (recoveries.length >= DEFAULT_BURST_THRESHOLD) {
    recoverySurge.push({
      signalId: 'recovery-surge:global',
      kind: 'recovery-surge',
      severity: 'info',
      subjectKey: 'global',
      since: new Date(sinceMs).toISOString(),
      until: new Date(nowMs).toISOString(),
      score: recoveries.length,
      threshold: DEFAULT_BURST_THRESHOLD,
      description: `${recoveries.length} incidents recovered in the last ${Math.round((opts.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS) / 60_000)}m — system is healing.`,
    });
  }
  const all = [...burst, ...agentDegradation, ...recoverySurge];
  // Sort: alert > warn > info, then score desc.
  all.sort((a, b) => sevRankSignal(b.severity) - sevRankSignal(a.severity) || b.score - a.score);
  const highest = all.length > 0 ? all[0]!.severity : null;
  return {
    signals: all,
    highestSeverity: highest,
    totalCount: all.length,
    computedAt: new Date(nowMs).toISOString(),
  };
}

function sevRankSignal(s: IntelligenceSignalSeverity): number {
  if (s === 'alert') return 3;
  if (s === 'warn') return 2;
  return 1;
}

/* ---------------- 7. helper: agent type guesser ---------------- */

/**
 * Best-effort AgentType extraction from an agentType string. Returns
 * the input if it matches an allowed AgentType literal, otherwise
 * 'custom'.
 */
export function asAgentType(s: string): AgentType {
  const allowed: ReadonlyArray<AgentType> = ['claude-code', 'codex', 'grok', 'gemini', 'hermes', 'custom'];
  return (allowed.includes(s as AgentType) ? s : 'custom') as AgentType;
}

/* Re-export AgentIncidentInsight for convenient type imports. */
export type { AgentIncidentInsight };