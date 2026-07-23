/**
 * v1.14: Incident Root Cause Evidence — pure-function module.
 *
 * Given a current HealthIncident and its surrounding context
 * (historical context, same-execution rollup, same-agent rollup,
 * optional priority insight), generates ordered "root cause evidence"
 * items that explain WHY this incident might be happening.
 *
 * NOT a diagnostic. NOT auto-remediation. Just deterministic
 * `kind / message / confidence` triples derived from existing data.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-
 * injected data — no DB, no globals, no Date.now() (a `nowIso` is
 * required and threaded through).
 *
 * Evidence kinds generated:
 *   - 'history'   — same-kind prior occurrences + recovery rate
 *   - 'severity'  — current severity + escalation count
 *   - 'impact'    — affected executions / agents breadth
 *   - 'agent'     — agent-level recurrence / recovery pattern
 *   - 'trend'     — recovery trend (recurrenceRate, avg duration)
 *   - 'priority'  — priority insight context (if provided)
 */

import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentHistoricalContext,
  IncidentRootCauseEvidence,
  IncidentPriorityInsight,
  RootCauseEvidenceItem,
} from '@agentos/shared';
import { parseIncidentKey } from './incident-history.js';

/* ---------------- confidence helpers ---------------- */

/** Saturating linear scale: ramps from 0..capInputs to 0..1. */
function saturating(count: number, capInputs: number): number {
  if (count <= 0 || capInputs <= 0) return 0;
  if (count >= capInputs) return 1;
  return count / capInputs;
}

/** Round to 3 decimals to keep outputs deterministic + readable. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* ---------------- evidence generators ---------------- */

function historyEvidence(
  current: HealthIncident,
  history: IncidentHistoricalContext,
): RootCauseEvidenceItem | null {
  if (history.occurrenceCount <= 1) return null;
  // Skip if the only occurrence is the current itself
  const priorCount = history.occurrenceCount - 1;
  if (priorCount <= 0) return null;
  const recoveryPct = Math.round((history.recoveredCount / history.occurrenceCount) * 100);
  const message =
    `This incident kind (${history.kind}) has been observed ${history.occurrenceCount} times ` +
    `in this pool (${priorCount} prior), with ${recoveryPct}% recovered overall.`;
  return {
    kind: 'history',
    message,
    confidence: r3(saturating(history.occurrenceCount, 5)),
    weight: 0.9,
  };
}

function severityEvidence(current: HealthIncident): RootCauseEvidenceItem {
  const sev: HealthAnomalySeverity = current.severity;
  const escalated = current.escalationCount > 0;
  let message: string;
  if (sev === 'critical' && escalated) {
    message = `Severity escalated ${current.escalationCount} time(s) to critical during this incident's lifetime.`;
  } else if (sev === 'critical') {
    message = `Severity is critical (max). ${current.escalationCount > 0 ? `${current.escalationCount} escalation(s) recorded.` : 'No escalations yet.'}`;
  } else {
    message = `Severity is high${escalated ? `; ${current.escalationCount} escalation(s) recorded.` : '.'}`;
  }
  return {
    kind: 'severity',
    message,
    confidence: 1.0, // current severity is always known
    weight: sev === 'critical' ? 0.95 : 0.7,
  };
}

function impactEvidence(
  current: HealthIncident,
  sameKindIncidents: HealthIncident[],
  executionToAgent: Map<string, string>,
): RootCauseEvidenceItem | null {
  // Scope: same-kind incidents sharing the current's execution OR
  // agent, deduped.
  const agent = executionToAgent.get(current.executionId);
  const peers = sameKindIncidents.filter((i) => {
    if (i.incidentKey === current.incidentKey) return false;
    if (i.executionId === current.executionId) return true;
    if (agent && executionToAgent.get(i.executionId) === agent) return true;
    return false;
  });
  const executions = new Set(peers.map((i) => i.executionId));
  if (executions.size === 0) return null;
  const agentStr = agent ?? 'unknown';
  const message = `Affected ${executions.size} execution(s)${agent ? ` under agent "${agentStr}"` : ''} with the same ${current.kind} anomaly.`;
  return {
    kind: 'impact',
    message,
    confidence: r3(saturating(executions.size, 3)),
    weight: 0.8,
  };
}

function agentEvidence(
  current: HealthIncident,
  sameKindIncidents: HealthIncident[],
  executionToAgent: Map<string, string>,
): RootCauseEvidenceItem | null {
  const agent = executionToAgent.get(current.executionId) as AgentType | undefined;
  if (!agent) return null;
  // All same-kind incidents for this agent (across all executions).
  const agentIncidents = sameKindIncidents.filter(
    (i) => executionToAgent.get(i.executionId) === agent,
  );
  if (agentIncidents.length < 2) return null;
  const recovered = agentIncidents.filter((i) => i.lifecycle === 'recovered').length;
  const recoveryPct = Math.round((recovered / agentIncidents.length) * 100);
  const message = `Agent "${agent}" has ${agentIncidents.length} ${current.kind} incident(s) in this pool ` +
    `(${recoveryPct}% recovered), suggesting a recurring degradation pattern.`;
  return {
    kind: 'agent',
    message,
    confidence: r3(saturating(agentIncidents.length, 4)),
    weight: 0.85,
  };
}

function trendEvidence(history: IncidentHistoricalContext): RootCauseEvidenceItem | null {
  if (history.occurrenceCount < 2) return null;
  const recoveryPct = Math.round((history.recoveredCount / history.occurrenceCount) * 100);
  const avg = history.averageDurationMs;
  const avgStr = avg !== null ? `avg ${Math.round(avg / 1000)}s recovery` : 'no recovery data';
  const message = `${history.kind} trend: ${recoveryPct}% recovery over ${history.occurrenceCount} occurrences, ` +
    `${avgStr}, recurrenceRate ${Math.round(history.recurrenceRate * 100)}%.`;
  return {
    kind: 'trend',
    message,
    confidence: r3(saturating(history.occurrenceCount, 4)),
    weight: 0.6,
  };
}

function priorityEvidence(
  priority: IncidentPriorityInsight | undefined,
  currentKind: HealthAnomalyKind,
): RootCauseEvidenceItem | null {
  if (!priority) return null;
  // The priority insight is already kind-aware (priorityId = kind:subjectKey),
  // so just describe the priority context.
  if (priority.subjectKey !== currentKind) return null;
  const topReason = priority.reasons[0];
  const reasonStr = topReason
    ? ` Top reason: ${topReason.message}.`
    : '';
  const message = `Priority "${priority.priorityId}" ranks at ${priority.priorityLevel} ` +
    `(score ${Math.round(priority.priorityScore)}).${reasonStr}`;
  return {
    kind: 'priority',
    message,
    confidence: r3(saturating(priority.priorityScore, 80)),
    weight: priority.priorityLevel === 'critical' ? 0.9 : 0.7,
  };
}

/* ---------------- main entry point ---------------- */

export interface BuildRootCauseArgs {
  /** The current incident's key (`${executionId}|${kind}`). */
  incidentKey: string;
  /** All HealthIncidents in the pool (typically from collectAllIncidents). */
  allIncidents: HealthIncident[];
  /** Historical context (from v1.13 buildHistoricalContext). */
  history: IncidentHistoricalContext;
  /** execId → agentType map (from v1.9 incident-correlation). */
  executionToAgent: Map<string, string>;
  /** Optional priority insight matching this incident's kind. */
  priority?: IncidentPriorityInsight;
  /** ISO timestamp for `computedAt`. Required for deterministic output. */
  nowIso: string;
}

/**
 * Generate an ordered root-cause evidence bundle for an incident.
 *
 * Returns null when:
 *   - incidentKey format is invalid (route → 400)
 *   - current incident not in pool (route → 404)
 *
 * Otherwise returns a populated bundle, ordered by:
 *   1. weight DESC (advisory importance)
 *   2. confidence DESC
 *   3. kind ASC (stable tie-break for tests)
 *
 * The function never throws; it returns an empty bundle when no
 * evidence can be generated (e.g. trivial single-incident system).
 */
export function buildRootCauseEvidence(args: BuildRootCauseArgs): IncidentRootCauseEvidence | null {
  const parsed = parseIncidentKey(args.incidentKey);
  if (!parsed) return null;
  const current = args.allIncidents.find((i) => i.incidentKey === args.incidentKey);
  if (!current) return null;
  const { kind, executionId } = parsed;

  const sameKind = args.allIncidents.filter((i) => i.kind === kind);

  const items: RootCauseEvidenceItem[] = [];

  // 1. History (uses IncidentHistoricalContext)
  const h = historyEvidence(current, args.history);
  if (h) items.push(h);

  // 2. Severity (always — current is known)
  items.push(severityEvidence(current));

  // 3. Impact (same-kind peers across execution / agent)
  const i = impactEvidence(current, sameKind, args.executionToAgent);
  if (i) items.push(i);

  // 4. Agent (same-agent rollup)
  const a = agentEvidence(current, sameKind, args.executionToAgent);
  if (a) items.push(a);

  // 5. Trend (uses IncidentHistoricalContext trend metrics)
  const t = trendEvidence(args.history);
  if (t) items.push(t);

  // 6. Priority (if supplied)
  const p = priorityEvidence(args.priority, kind);
  if (p) items.push(p);

  // Order by weight DESC, then confidence DESC, then kind ASC.
  items.sort((x, y) => {
    if (y.weight !== x.weight) return y.weight - x.weight;
    if (y.confidence !== x.confidence) return y.confidence - x.confidence;
    return x.kind.localeCompare(y.kind);
  });

  const confidence = items.reduce((m, it) => Math.max(m, it.confidence), 0);

  return {
    incidentKey: args.incidentKey,
    executionId,
    kind,
    evidence: items,
    confidence: r3(confidence),
    hasEvidence: items.length > 0,
    computedAt: args.nowIso,
  };
}