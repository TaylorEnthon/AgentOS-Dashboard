/**
 * v1.11: Incident Intelligence Prioritization — pure-function module.
 *
 * Ranks IntelligenceSignals by composite priority score (rule-based,
 * deterministic, no ML). Each priority insight carries an evidence
 * chain explaining the score.
 *
 * Score formula (sum in [0, 100]):
 *   - severity  (max 40)  critical => 40, high => 20
 *   - frequency (max 10)  burst-detected => 10, else 0
 *   - impact    (max 30)  min(30, 5 × affectedExecutions + 10 × affectedAgents)
 *   - trend     (max 20)  degrading => 20, stable => 5, improving/no-data => 0
 *   - base      (max 0)   placeholder; never contributes
 *
 * Priority level buckets:
 *   - 'critical'  score >= 70
 *   - 'high'      score >= 50
 *   - 'medium'    score >= 30
 *   - 'low'       score <  30
 *
 * Pure / read-only / deterministic.
 */

import type {
  AgentReliabilityTrend,
  HealthIncident,
  IncidentPriorityInsight,
  IncidentPrioritySummary,
  IntelligenceSignal,
  IntelligenceSignalKind,
  IntelligenceSignalSeverity,
  PriorityEvidence,
  PriorityLevel,
  TrendDirection,
} from '@agentos/shared';

/* ---------------- constants (score component caps) ---------------- */

const MAX_SCORE = 100;
const SEVERITY_CRITICAL = 40;
const SEVERITY_HIGH = 20;
const FREQUENCY_BURST = 10;
const IMPACT_MAX = 30;
const IMPACT_PER_EXECUTION = 5;
const IMPACT_PER_AGENT = 10;
const TREND_DEGRADING = 20;
const TREND_STABLE = 5;

const LEVEL_THRESHOLDS: Array<[PriorityLevel, number]> = [
  ['critical', 70],
  ['high', 50],
  ['medium', 30],
  ['low', 0],
];

/* ---------------- helpers ---------------- */

/**
 * Compute trend hint for a given subject. For agent-keyed subjects we
 * look up the agent's `trendDirection`; for kind-keyed subjects
 * (burst / kind-surge) we return null since trend is agent-scoped.
 */
function trendHintForSubject(
  subjectKey: string,
  signalKind: IntelligenceSignalKind,
  agentTrends: AgentReliabilityTrend[],
): TrendDirection | null {
  // Only agent-keyed subjects can have trend hints.
  if (signalKind !== 'agent-degradation' && signalKind !== 'recovery-surge') {
    return null;
  }
  const trend = agentTrends.find((t) => t.agentType === subjectKey);
  return trend ? trend.trendDirection : null;
}

/**
 * Compute the affectedExecutions / affectedAgents from the incidents
 * that produced the signal. Used as evidence for the impact
 * component.
 */
function impactFromIncidents(
  subjectKey: string,
  signalKind: IntelligenceSignalKind,
  windowIncidents: HealthIncident[],
  executionToAgent: Map<string, string>,
): { affectedExecutions: number; affectedAgents: number } {
  // Filter incidents that match the subject.
  // For agent-degradation: incidents whose execution is owned by this agent.
  // For burst: incidents of the same kind.
  // For recovery-surge: same as agent-degradation (we use the subjectKey as agent).
  let relevant: HealthIncident[];
  if (signalKind === 'agent-degradation' || signalKind === 'recovery-surge') {
    relevant = windowIncidents.filter((inc) => executionToAgent.get(inc.executionId) === subjectKey);
  } else {
    // burst / kind-surge: subjectKey is the kind name.
    relevant = windowIncidents.filter((inc) => inc.kind === subjectKey);
  }
  const execs = new Set(relevant.map((inc) => inc.executionId));
  const agents = new Set<string>();
  for (const inc of relevant) {
    const a = executionToAgent.get(inc.executionId);
    if (a) agents.add(a);
  }
  return {
    affectedExecutions: execs.size,
    affectedAgents: agents.size,
  };
}

/* ---------------- 1. score components ---------------- */

interface ScoreComponents {
  severity: number;
  frequency: number;
  impact: number;
  trend: number;
  /** total = severity + frequency + impact + trend. */
  total: number;
}

function computeScoreComponents(args: {
  signal: IntelligenceSignal;
  trendHint: TrendDirection | null;
  affectedExecutions: number;
  affectedAgents: number;
}): ScoreComponents {
  // 1. Severity — pulled from signal.severity. We map to a score
  //    component: alert = critical (40), warn = high (20), info = 0.
  const severity =
    args.signal.severity === 'alert' ? SEVERITY_CRITICAL :
    args.signal.severity === 'warn'  ? SEVERITY_HIGH :
    0;

  // 2. Frequency — only burst signal contributes.
  //    "burst" indicates rapid same-kind incident spike, which is
  //    always at least 10 points when the signal fires.
  const frequency = args.signal.kind === 'burst' ? FREQUENCY_BURST : 0;

  // 3. Impact — affectedExecutions × 5 + affectedAgents × 10, capped
  //    at 30. (We ignore signalScore here to keep the formula
  //    deterministic against the impact set, not against the
  //    detector's threshold-pass logic.)
  const impactRaw = args.affectedExecutions * IMPACT_PER_EXECUTION
                  + args.affectedAgents   * IMPACT_PER_AGENT;
  const impact = Math.min(IMPACT_MAX, impactRaw);

  // 4. Trend — degrading => 20, stable => 5, else 0.
  const trend =
    args.trendHint === 'degrading' ? TREND_DEGRADING :
    args.trendHint === 'stable'    ? TREND_STABLE :
    0;

  return {
    severity,
    frequency,
    impact,
    trend,
    total: Math.min(MAX_SCORE, severity + frequency + impact + trend),
  };
}

/* ---------------- 2. evidence chain ---------------- */

function buildEvidence(
  comps: ScoreComponents,
  signal: IntelligenceSignal,
  affectedExecutions: number,
  affectedAgents: number,
  trendHint: TrendDirection | null,
): PriorityEvidence[] {
  const out: PriorityEvidence[] = [];
  // Severity evidence
  if (comps.severity > 0) {
    out.push({
      kind: 'severity',
      contribution: comps.severity,
      maxContribution: SEVERITY_CRITICAL,
      message: signal.severity === 'alert'
        ? `Signal flagged as alert (critical severity) — contributes ${comps.severity}/${SEVERITY_CRITICAL}.`
        : `Signal flagged as warn (high severity) — contributes ${comps.severity}/${SEVERITY_HIGH}.`,
    });
  }
  // Frequency evidence
  if (comps.frequency > 0) {
    out.push({
      kind: 'frequency',
      contribution: comps.frequency,
      maxContribution: FREQUENCY_BURST,
      message: `Burst detected: ${signal.score} ${signal.subjectKey} incidents in the window (threshold ${signal.threshold}) — contributes ${comps.frequency}/${FREQUENCY_BURST}.`,
    });
  }
  // Impact evidence
  if (comps.impact > 0) {
    const impactRaw = affectedExecutions * IMPACT_PER_EXECUTION
                     + affectedAgents   * IMPACT_PER_AGENT;
    out.push({
      kind: 'impact',
      contribution: comps.impact,
      maxContribution: IMPACT_MAX,
      message: `Affects ${affectedExecutions} execution${affectedExecutions === 1 ? '' : 's'} across ${affectedAgents} agent${affectedAgents === 1 ? '' : 's'} (raw impact ${impactRaw}, capped at ${IMPACT_MAX}) — contributes ${comps.impact}/${IMPACT_MAX}.`,
    });
  }
  // Trend evidence
  if (comps.trend > 0) {
    out.push({
      kind: 'trend',
      contribution: comps.trend,
      maxContribution: TREND_DEGRADING,
      message: `Agent trend is "${trendHint}" (vs previous window) — contributes ${comps.trend}/${trendHint === 'degrading' ? TREND_DEGRADING : TREND_STABLE}.`,
    });
  }
  // Base evidence (placeholder when no other evidence fired — shows the
  // user the system considered the signal but found no urgency).
  if (out.length === 0) {
    out.push({
      kind: 'base',
      contribution: 0,
      maxContribution: 0,
      message: `No critical signals detected in the window for this subject.`,
    });
  }
  // Sort descending by contribution; ties broken by component order.
  out.sort((a, b) => b.contribution - a.contribution);
  return out;
}

/* ---------------- 3. priority level mapping ---------------- */

function scoreToLevel(score: number): PriorityLevel {
  for (const [level, threshold] of LEVEL_THRESHOLDS) {
    if (score >= threshold) return level;
  }
  return 'low';
}

/* ---------------- 4. single priority builder ---------------- */

/**
 * Build one IncidentPriorityInsight from a signal + supporting data.
 * Pure / read-only / deterministic.
 */
export function buildPriority(args: {
  signal: IntelligenceSignal;
  agentTrends: AgentReliabilityTrend[];
  windowIncidents: HealthIncident[];
  executionToAgent: Map<string, string>;
}): IncidentPriorityInsight {
  const { signal, agentTrends, windowIncidents, executionToAgent } = args;

  // Trend hint from agent trends (only meaningful for agent-keyed signals).
  const trendHint = trendHintForSubject(signal.subjectKey, signal.kind, agentTrends);

  // Impact metrics from the incidents that produced the signal.
  const { affectedExecutions, affectedAgents } = impactFromIncidents(
    signal.subjectKey,
    signal.kind,
    windowIncidents,
    executionToAgent,
  );

  // Score components.
  const comps = computeScoreComponents({ signal, trendHint, affectedExecutions, affectedAgents });

  // Evidence chain.
  const reasons = buildEvidence(comps, signal, affectedExecutions, affectedAgents, trendHint);

  return {
    priorityId: `${signal.kind}:${signal.subjectKey}`,
    signalKind: signal.kind,
    signalSeverity: signal.severity,
    subjectKey: signal.subjectKey,
    subjectLabel: signal.subjectLabel,
    signalId: signal.signalId,
    signalScore: signal.score,
    signalThreshold: signal.threshold,
    signalDescription: signal.description,
    since: signal.since,
    until: signal.until,
    priorityScore: comps.total,
    priorityLevel: scoreToLevel(comps.total),
    reasons,
    trendHint,
  };
}

/* ---------------- 5. workspace priority summary ---------------- */

/**
 * Build a workspace-level priority summary from a set of signals +
 * supporting data. Top-N entries sorted by:
 *   1. priorityLevel rank desc (critical > high > medium > low)
 *   2. priorityScore desc
 *   3. signalSeverity rank desc (alert > warn > info)
 *   4. signalId asc (stable)
 */
export function buildPriorities(args: {
  signals: IntelligenceSignal[];
  agentTrends: AgentReliabilityTrend[];
  windowIncidents: HealthIncident[];
  executionToAgent: Map<string, string>;
  topN?: number;
  nowMs?: number;
  sinceIso?: string;
  untilIso?: string;
}): IncidentPrioritySummary {
  const topN = args.topN ?? 10;
  const computedAt = new Date(args.nowMs ?? Date.now()).toISOString();
  const priorities: IncidentPriorityInsight[] = args.signals.map((signal) =>
    buildPriority({
      signal,
      agentTrends: args.agentTrends,
      windowIncidents: args.windowIncidents,
      executionToAgent: args.executionToAgent,
    }),
  );
  // Sort.
  priorities.sort((a, b) => {
    const levelDiff = levelRank(b.priorityLevel) - levelRank(a.priorityLevel);
    if (levelDiff !== 0) return levelDiff;
    const scoreDiff = b.priorityScore - a.priorityScore;
    if (scoreDiff !== 0) return scoreDiff;
    const sevDiff = signalSeverityRank(b.signalSeverity) - signalSeverityRank(a.signalSeverity);
    if (sevDiff !== 0) return sevDiff;
    return a.priorityId.localeCompare(b.priorityId);
  });

  // Counts by level.
  const byLevel: Record<PriorityLevel, number> = {
    critical: 0, high: 0, medium: 0, low: 0,
  };
  for (const p of priorities) byLevel[p.priorityLevel]++;

  const highestLevel = priorities.length > 0 ? priorities[0]!.priorityLevel : null;

  // Window boundaries — prefer caller-supplied sinceIso/untilIso,
  // else pull from the first signal (or 'now' if none).
  const since = args.sinceIso ?? args.signals[0]?.since ?? computedAt;
  const until = args.untilIso ?? args.signals[0]?.until ?? computedAt;

  return {
    priorities: priorities.slice(0, topN),
    highestLevel,
    byLevel,
    totalCount: priorities.length,
    since,
    until,
    computedAt,
  };
}

function levelRank(level: PriorityLevel): number {
  if (level === 'critical') return 4;
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

function signalSeverityRank(s: IntelligenceSignalSeverity): number {
  if (s === 'alert') return 3;
  if (s === 'warn') return 2;
  return 1;
}