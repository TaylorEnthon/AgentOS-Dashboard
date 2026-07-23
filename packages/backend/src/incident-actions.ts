/**
 * v1.16: Incident Recommended Action — pure-function module.
 *
 * Given a populated IncidentInvestigationReport (v1.15), emits an
 * ordered list of deterministic "suggested next steps" for the user.
 *
 * Pure / read-only / deterministic. No I/O, no DB, no ML. The
 * actions are NEVER auto-executed — humans decide whether to act on
 * them. The function just maps existing report signals to action
 * suggestions via fixed threshold rules.
 *
 * Rules (all deterministic):
 *   - 'inspect-agent'    fires when report.evidence has an 'agent' item
 *                        AND the top affected agent has ≥ 2 incidents.
 *   - 'review-execution' fires when report.investigation.affectedExecutions
 *                        has more than 1 row.
 *   - 'compare-history'  fires when report.history.occurrenceCount > 3.
 *   - 'watch-recurrence' fires when report.history.occurrenceCount ≥ 2 AND
 *                        recovery is incomplete (recoveredCount < occurrenceCount),
 *                        OR when history.recurrenceRate > 0.5.
 *
 * Priority assignment (per rule):
 *   - inspect-agent:    high if top agent incidents ≥ 4, medium if ≥ 2
 *   - review-execution: high if > 3 executions, medium if > 1
 *   - compare-history:  high if occurrenceCount > 6, medium if > 3
 *   - watch-recurrence: high if recovery rate < 50%, medium otherwise
 */

import type {
  IncidentRecommendedAction,
  IncidentRecommendedActionBundle,
  IncidentRecommendedActionPriority,
  IncidentInvestigationReport,
} from '@agentos/shared';

/* ---------------- thresholds (deterministic constants) ---------------- */

const AGENT_INCIDENTS_MEDIUM = 2;
const AGENT_INCIDENTS_HIGH = 4;

const AFFECTED_EXECUTIONS_MEDIUM = 2; // strictly > this = medium
const AFFECTED_EXECUTIONS_HIGH = 3;   // strictly > this = high

const HISTORY_OCCURRENCES_MEDIUM = 3;  // strictly > this = medium
const HISTORY_OCCURRENCES_HIGH = 6;    // strictly > this = high

const RECOVERY_RATE_MEDIUM = 0.8;
const RECOVERY_RATE_HIGH = 0.5;

const RECURRENCE_RATE_WATCH = 0.5;

/* ---------------- helpers ---------------- */

function priorityRank(p: IncidentRecommendedActionPriority): number {
  if (p === 'high') return 3;
  if (p === 'medium') return 2;
  return 1;
}

/* ---------------- per-rule builders ---------------- */

function inspectAgentAction(report: IncidentInvestigationReport): IncidentRecommendedAction | null {
  // Trigger: evidence has at least one 'agent' item
  const agentEvidence = report.evidence.evidence.find((e) => e.kind === 'agent');
  if (!agentEvidence) return null;

  // Find the top agent by incidentCount from the investigation view
  const agents = report.investigation.affectedAgents;
  const top = agents.length > 0
    ? agents.slice().sort((a, b) => b.incidentCount - a.incidentCount)[0]
    : undefined;
  const agentCount = top?.incidentCount ?? 0;

  if (agentCount < AGENT_INCIDENTS_MEDIUM) return null;

  const priority: IncidentRecommendedActionPriority =
    agentCount >= AGENT_INCIDENTS_HIGH ? 'high' : 'medium';

  const agentLabel = top?.agentType ?? 'unknown';
  return {
    type: 'inspect-agent',
    priority,
    reason: `Agent "${agentLabel}" has ${agentCount} ${report.history.kind} incident(s); review the agent's recent runs and configuration for a recurring degradation pattern.`,
  };
}

function reviewExecutionAction(report: IncidentInvestigationReport): IncidentRecommendedAction | null {
  const executions = report.investigation.affectedExecutions.length;
  if (executions <= 1) return null;

  const priority: IncidentRecommendedActionPriority =
    executions > AFFECTED_EXECUTIONS_HIGH ? 'high' : 'medium';

  return {
    type: 'review-execution',
    priority,
    reason: `${executions} execution(s) are affected; review each one's incidents, sessions, and commits to localize the impact.`,
  };
}

function compareHistoryAction(report: IncidentInvestigationReport): IncidentRecommendedAction | null {
  const occurrences = report.history.occurrenceCount;
  if (occurrences <= HISTORY_OCCURRENCES_MEDIUM) return null;

  const priority: IncidentRecommendedActionPriority =
    occurrences > HISTORY_OCCURRENCES_HIGH ? 'high' : 'medium';

  const recoveryPct = Math.round((report.history.recoveredCount / occurrences) * 100);
  return {
    type: 'compare-history',
    priority,
    reason: `This ${report.history.kind} anomaly has occurred ${occurrences} times (${recoveryPct}% recovered); compare with prior occurrences to identify drift or regression.`,
  };
}

function watchRecurrenceAction(report: IncidentInvestigationReport): IncidentRecommendedAction | null {
  const occurrences = report.history.occurrenceCount;
  if (occurrences < 2) return null;

  const recoveryRate = occurrences > 0
    ? report.history.recoveredCount / occurrences
    : 0;
  const incomplete = report.history.recoveredCount < occurrences;
  const highRecurrence = report.history.recurrenceRate > RECURRENCE_RATE_WATCH;

  if (!incomplete && !highRecurrence) return null;

  const priority: IncidentRecommendedActionPriority =
    recoveryRate < RECOVERY_RATE_HIGH ? 'high' : 'medium';

  const reason = highRecurrence
    ? `Recurrence rate is ${Math.round(report.history.recurrenceRate * 100)}% (severity upgrades observed); monitor closely for additional escalations.`
    : `Recovery is incomplete (${report.history.recoveredCount}/${occurrences} resolved); monitor for further escalation or watch for new occurrences.`;
  return {
    type: 'watch-recurrence',
    priority,
    reason,
  };
}

/* ---------------- main entry point ---------------- */

export interface BuildActionsArgs {
  /** The full IncidentInvestigationReport (v1.15) — caller-supplied. */
  report: IncidentInvestigationReport | null;
  /** ISO timestamp for `generatedAt`. Required for determinism. */
  nowIso: string;
}

/**
 * Build the recommended-action bundle for a single incident.
 *
 * Returns `null` only when `report` itself is null (route should map
 * to 404). Otherwise returns a populated bundle with zero or more
 * action suggestions. When no rule fires, the bundle still has
 * `hasActions: false` and `actions: []` — the route returns 200.
 *
 * Ordering (stable): priority DESC, then type ASC.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-
 * injected data — no DB, no globals, no Date.now().
 */
export function buildRecommendedActions(args: BuildActionsArgs): IncidentRecommendedActionBundle | null {
  if (!args.report) return null;
  const report = args.report;
  const nowIso = args.nowIso;

  const actions: IncidentRecommendedAction[] = [];

  const inspectAgent = inspectAgentAction(report);
  if (inspectAgent) actions.push(inspectAgent);

  const reviewExecution = reviewExecutionAction(report);
  if (reviewExecution) actions.push(reviewExecution);

  const compareHistory = compareHistoryAction(report);
  if (compareHistory) actions.push(compareHistory);

  const watchRecurrence = watchRecurrenceAction(report);
  if (watchRecurrence) actions.push(watchRecurrence);

  // Stable ordering: priority DESC, then type ASC.
  actions.sort((a, b) => {
    const diff = priorityRank(b.priority) - priorityRank(a.priority);
    if (diff !== 0) return diff;
    return a.type.localeCompare(b.type);
  });

  return {
    incidentKey: report.incidentKey,
    actions,
    hasActions: actions.length > 0,
    generatedAt: nowIso,
  };
}