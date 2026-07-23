/**
 * v1.17: Incident Investigation Narrative — pure-function module.
 *
 * Given a populated IncidentInvestigationReport (v1.15), generates a
 * 3-section human-readable narrative:
 *
 *   1. `summary`     — 1-2 sentences describing WHAT the incident is
 *                      (kind + severity + scope).
 *   2. `findings`    — ordered observed facts derived from the report
 *                      (history stats, evidence items, investigation
 *                      summary). These are FACTS, not causes.
 *   3. `hypotheses`  — "possible explanations" — explicitly NOT root
 *                      cause. Always ends with a caveat reminding the
 *                      reader that the hypotheses are pattern-based,
 *                      not verified.
 *
 * NOT LLM. NOT ML. NOT auto-diagnosis. NOT auto-fix. Pure template
 * composition over the v1.15 report fields.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-
 * injected data — no DB, no globals, no Date.now() (a `nowIso` is
 * required and threaded through to `generatedAt`).
 */

import type {
  HealthAnomalyKind,
  IncidentHistoricalContext,
  IncidentInvestigationNarrative,
  IncidentInvestigationReport,
  IncidentInvestigationView,
  IncidentRootCauseEvidence,
  RootCauseEvidenceItem,
} from '@agentos/shared';

/* ---------------- helpers ---------------- */

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 100);
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'unknown';
  // Display only the date portion; full ISO is noisy in narrative.
  return iso.slice(0, 10);
}

/* ---------------- summary ---------------- */

function buildSummary(report: IncidentInvestigationReport): string {
  const inv: IncidentInvestigationView = report.investigation;
  const hist: IncidentHistoricalContext = report.history;
  const total = inv.summary.totalRelatedIncidents;
  const executions = inv.affectedExecutions.length;
  const agents = inv.affectedAgents.length;
  const severity = inv.summary.criticalCount > 0 ? 'critical' : 'high';
  const topAgent = inv.affectedAgents.length > 0
    ? inv.affectedAgents.slice().sort((a, b) => b.incidentCount - a.incidentCount)[0]!.agentType
    : null;
  const currentExecution = report.incidentKey.includes('|')
    ? report.incidentKey.split('|')[0]
    : report.incidentKey;

  // Multi-incident scope.
  if (total > 1 || executions > 1) {
    const agentPart = topAgent ? ` under agent "${topAgent}"` : '';
    const agentCountPart = agents > 1 ? ` across ${agents} agents` : '';
    return `${total} ${hist.kind} ${total === 1 ? 'incident was' : 'incidents were'} observed across ${executions} execution(s)${agentPart}${agentCountPart} (severity: ${severity}).`;
  }
  // Single incident scope.
  return `A ${hist.kind} incident was detected on execution ${currentExecution} (severity: ${severity}).`;
}

/* ---------------- findings ---------------- */

function buildFindings(report: IncidentInvestigationReport): string[] {
  const findings: string[] = [];
  const inv = report.investigation;
  const hist = report.history;
  const ev = report.evidence;

  // 1) From investigation summary (scope).
  const total = inv.summary.totalRelatedIncidents;
  const executions = inv.affectedExecutions.length;
  const agents = inv.affectedAgents.length;
  if (total > 0) {
    findings.push(`Scope: ${total} related incident(s) across ${executions} execution(s) and ${agents} agent(s).`);
  }
  findings.push(`Priority level: ${inv.priority.priorityLevel} (score ${Math.round(inv.priority.priorityScore)}).`);

  // 2) From historical context.
  if (hist.occurrenceCount > 1) {
    const recoveryPct = pct(hist.recoveredCount, hist.occurrenceCount);
    findings.push(`This ${hist.kind} kind has occurred ${hist.occurrenceCount} times historically (recovery rate: ${recoveryPct}%).`);
  } else {
    findings.push(`This is the first recorded ${hist.kind} incident in the current pool.`);
  }
  if (hist.firstSeen) {
    findings.push(`First seen: ${fmtDate(hist.firstSeen)}; last seen: ${fmtDate(hist.lastSeen)}.`);
  }
  if (hist.averageDurationMs !== null) {
    findings.push(`Average recovery time: ${fmtMs(hist.averageDurationMs)}; max: ${fmtMs(hist.maxDurationMs ?? hist.averageDurationMs)}.`);
  }
  if (hist.recurrenceRate > 0) {
    const rRate = pct(Math.round(hist.recurrenceRate * 100), 100);
    findings.push(`Severity-upgrade recurrence rate: ${rRate}% (some occurrences escalated to critical).`);
  }

  // 3) From evidence (passthrough, prefixed with kind for clarity).
  for (const item of ev.evidence) {
    findings.push(`[${item.kind}] ${item.message}`);
  }

  return findings;
}

/* ---------------- hypotheses ---------------- */

function buildHypotheses(report: IncidentInvestigationReport): string[] {
  const hypotheses: string[] = [];
  const inv = report.investigation;
  const hist = report.history;
  const ev = report.evidence;

  // Bucket evidence items by kind so we can summarize without dumping every one.
  const kinds = new Set<RootCauseEvidenceItem['kind']>();
  for (const item of ev.evidence) kinds.add(item.kind);

  // 1) Severity-driven hypothesis.
  if (kinds.has('severity') || inv.summary.criticalCount > 0) {
    if (inv.summary.criticalCount > 0) {
      hypotheses.push('Severity pattern: critical-severity signals are present; the underlying issue may be serious and warrants prompt attention.');
    } else {
      hypotheses.push('Severity pattern: all signals are at "high" severity; the issue is present but not yet critical.');
    }
  }

  // 2) History-driven hypothesis (recurring kind).
  if (kinds.has('history') || hist.occurrenceCount > 1) {
    hypotheses.push(`Recurring kind pattern: ${hist.kind} has occurred ${hist.occurrenceCount} times in this pool, which could indicate a systemic or repeating condition rather than a one-off event.`);
  }

  // 3) Agent-driven hypothesis.
  if (kinds.has('agent')) {
    const topAgent = inv.affectedAgents.length > 0
      ? inv.affectedAgents.slice().sort((a, b) => b.incidentCount - a.incidentCount)[0]!
      : null;
    if (topAgent) {
      hypotheses.push(`Agent-level pattern: agent "${topAgent.agentType}" has ${topAgent.incidentCount} ${hist.kind} incident(s), suggesting a degradation pattern specific to this agent.`);
    }
  }

  // 4) Impact-driven hypothesis (multi-execution).
  if (kinds.has('impact') || inv.affectedExecutions.length > 1) {
    hypotheses.push(`Multi-execution impact: ${inv.affectedExecutions.length} execution(s) are affected, suggesting the issue extends beyond a single execution.`);
  }

  // 5) Trend-driven hypothesis (incomplete recovery OR high recurrenceRate).
  if (kinds.has('trend') || hist.recurrenceRate > 0.5 ||
      (hist.occurrenceCount >= 2 && hist.recoveredCount < hist.occurrenceCount)) {
    hypotheses.push('Recovery instability: recovery is incomplete or severity has escalated; the situation may continue to worsen if unattended.');
  }

  // 6) Priority-driven hypothesis.
  if (kinds.has('priority')) {
    hypotheses.push(`Priority context: this incident is ranked at ${inv.priority.priorityLevel}; review the priority reasons to understand the underlying driver.`);
  }

  // 7) Always-present caveat — these are NOT root causes.
  hypotheses.push('Caveat: these are hypotheses based on observable patterns from the report, NOT verified root causes. Use them as starting points for human investigation, not as diagnoses.');

  return hypotheses;
}

/* ---------------- main entry point ---------------- */

export interface BuildNarrativeArgs {
  /** Full IncidentInvestigationReport (v1.15) — caller-supplied. */
  report: IncidentInvestigationReport | null;
  /** ISO timestamp for `generatedAt`. Required for determinism. */
  nowIso: string;
}

/**
 * Build the human-readable investigation narrative for a single incident.
 *
 * Returns `null` only when `report` itself is null (route should map
 * to 404). Otherwise returns a populated bundle with a deterministic
 * `summary`, an ordered `findings[]`, and an ordered `hypotheses[]`.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-
 * injected data — no DB, no globals, no Date.now().
 */
export function buildInvestigationNarrative(
  args: BuildNarrativeArgs,
): IncidentInvestigationNarrative | null {
  if (!args.report) return null;
  const report = args.report;

  return {
    incidentKey: report.incidentKey,
    summary: buildSummary(report),
    findings: buildFindings(report),
    hypotheses: buildHypotheses(report),
    generatedAt: args.nowIso,
  };
}