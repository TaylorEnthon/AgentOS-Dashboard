/**
 * v1.12: Incident Investigation Workflow — pure-function module.
 *
 * Builds an IncidentInvestigationView from a single Priority Insight,
 * surfacing the incidents that produced the priority, the executions
 * and agents affected, and a summary metrics block.
 *
 * The mapping logic mirrors `impactFromIncidents` in
 * `incident-priority.ts`:
 *   - agent-degradation / recovery-surge: incidents whose execution
 *     is owned by the subject agent.
 *   - burst / kind-surge: incidents of the same kind as subjectKey.
 *
 * Pure / read-only / deterministic.
 */

import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentInvestigationView,
  IncidentPriorityInsight,
  IncidentTemporalSummary,
  IntelligenceSignal,
  InvestigationAgentRow,
  InvestigationExecutionRow,
  PriorityEvidence,
} from '@agentos/shared';

/* ---------------- 1. related-incident filter ---------------- */

/**
 * Filter incidents that match a priority's subject. Mirrors
 * `impactFromIncidents` from incident-priority.ts.
 */
function relatedIncidents(
  signal: IntelligenceSignal,
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
): HealthIncident[] {
  if (signal.kind === 'agent-degradation' || signal.kind === 'recovery-surge') {
    return incidents.filter((inc) => executionToAgent.get(inc.executionId) === signal.subjectKey);
  }
  // burst / kind-surge: subjectKey is the kind name.
  return incidents.filter((inc) => inc.kind === signal.subjectKey);
}

/* ---------------- 2. per-execution aggregation ---------------- */

function buildExecutionRows(
  related: HealthIncident[],
  executionToAgent: Map<string, string>,
): InvestigationExecutionRow[] {
  const byExec = new Map<string, HealthIncident[]>();
  for (const inc of related) {
    const arr = byExec.get(inc.executionId);
    if (arr) arr.push(inc);
    else byExec.set(inc.executionId, [inc]);
  }
  const out: InvestigationExecutionRow[] = [];
  for (const [executionId, list] of byExec.entries()) {
    let active = 0, recovered = 0, detected = 0, ongoing = 0;
    let worst: HealthAnomalySeverity = 'high';
    let lastIncidentAt: string | null = null;
    for (const inc of list) {
      if (inc.lifecycle === 'recovered') recovered++;
      else if (inc.lifecycle === 'detected') { detected++; active++; }
      else if (inc.lifecycle === 'ongoing')  { ongoing++;  active++; }
      if (inc.severity === 'critical') worst = 'critical';
      if (lastIncidentAt === null || Date.parse(inc.detectedAt) > Date.parse(lastIncidentAt)) {
        lastIncidentAt = inc.detectedAt;
      }
    }
    out.push({
      executionId,
      agentType: (executionToAgent.get(executionId) ?? 'custom') as AgentType,
      incidentCount: list.length,
      activeCount: active,
      worstSeverity: worst,
      lifecycleCounts: { detected, ongoing, recovered },
      lastIncidentAt,
    });
  }
  // Sort: most incidents first, then worst severity, then name asc.
  out.sort((a, b) =>
    b.incidentCount - a.incidentCount ||
    sevRank(b.worstSeverity) - sevRank(a.worstSeverity) ||
    a.executionId.localeCompare(b.executionId),
  );
  return out;
}

function sevRank(s: HealthAnomalySeverity): number {
  return s === 'critical' ? 2 : 1;
}

/* ---------------- 3. per-agent aggregation ---------------- */

function buildAgentRows(
  related: HealthIncident[],
  executionRows: InvestigationExecutionRow[],
): InvestigationAgentRow[] {
  const byAgent = new Map<string, HealthIncident[]>();
  for (const inc of related) {
    const exec = executionRows.find((r) => r.executionId === inc.executionId);
    const agent = exec?.agentType ?? 'custom';
    const arr = byAgent.get(agent);
    if (arr) arr.push(inc);
    else byAgent.set(agent, [inc]);
  }
  const out: InvestigationAgentRow[] = [];
  for (const [agentType, list] of byAgent.entries()) {
    let active = 0, recovered = 0, critical = 0;
    let worst: HealthAnomalySeverity = 'high';
    const byKindMap = new Map<HealthAnomalyKind, number>();
    for (const inc of list) {
      if (inc.lifecycle === 'recovered') recovered++;
      else active++;
      if (inc.severity === 'critical') { worst = 'critical'; critical++; }
      byKindMap.set(inc.kind, (byKindMap.get(inc.kind) ?? 0) + 1);
    }
    const execCount = executionRows.filter((r) => r.agentType === agentType).length;
    const byKind = Array.from(byKindMap.entries())
      .map(([kind, incidentCount]) => ({ kind, incidentCount }))
      .sort((a, b) => b.incidentCount - a.incidentCount || a.kind.localeCompare(b.kind));
    out.push({
      agentType,
      executionCount: execCount,
      incidentCount: list.length,
      activeCount: active,
      recoveredCount: recovered,
      criticalCount: critical,
      worstSeverity: worst,
      byKind,
    });
  }
  out.sort((a, b) =>
    b.incidentCount - a.incidentCount ||
    sevRank(b.worstSeverity) - sevRank(a.worstSeverity) ||
    a.agentType.localeCompare(b.agentType),
  );
  return out;
}

/* ---------------- 4. summary block ---------------- */

interface SummaryInput {
  related: HealthIncident[];
  since: string;
  until: string;
}

function buildSummary({ related, since, until }: SummaryInput): IncidentInvestigationView['summary'] {
  let active = 0, recovered = 0, critical = 0, high = 0;
  for (const inc of related) {
    if (inc.lifecycle === 'recovered') recovered++;
    else active++;
    if (inc.severity === 'critical') critical++;
    else high++;
  }
  return {
    totalRelatedIncidents: related.length,
    activeCount: active,
    recoveredCount: recovered,
    criticalCount: critical,
    highCount: high,
    timeRange: { since, until },
  };
}

/* ---------------- 5. main entry point ---------------- */

/**
 * Build an IncidentInvestigationView for a single Priority Insight.
 * Pure / read-only / deterministic.
 *
 * Returns `null` when:
 *   - the priority is null
 *   - the priority is not in the supplied priorities list
 *   - the priorities list is empty
 *
 * @param priorityId       stable id of the priority to investigate
 * @param priorities       full list of priorities (output of buildPriorities)
 * @param windowIncidents  incidents in the time window (for related-incident lookup)
 * @param executionToAgent exec → agent map (for agent rollup)
 * @param opts.nowMs       timestamp for computedAt (test hook)
 */
export function buildInvestigation(args: {
  priorityId: string;
  priorities: IncidentPriorityInsight[];
  windowIncidents: HealthIncident[];
  executionToAgent: Map<string, string>;
  since: string;
  until: string;
  nowMs?: number;
}): IncidentInvestigationView | null {
  const { priorityId, priorities, windowIncidents, executionToAgent, since, until } = args;
  const computedAt = new Date(args.nowMs ?? Date.now()).toISOString();

  // 1. Find the priority
  const priority = priorities.find((p) => p.priorityId === priorityId);
  if (!priority) return null;

  // 2. Reconstruct a minimal signal from the priority (the priority
  //    embeds the signal fields; we use the priority's signal* fields
  //    directly to avoid re-fetching the IntelligenceSignal list).
  const signal: IntelligenceSignal = {
    signalId: priority.signalId,
    kind: priority.signalKind,
    severity: priority.signalSeverity,
    subjectKey: priority.subjectKey,
    subjectLabel: priority.subjectLabel,
    since: priority.since,
    until: priority.until,
    score: priority.signalScore,
    threshold: priority.signalThreshold,
    description: priority.signalDescription,
  };

  // 3. Find related incidents
  const related = relatedIncidents(signal, windowIncidents, executionToAgent);

  // 4. Per-execution + per-agent rollups
  const affectedExecutions = buildExecutionRows(related, executionToAgent);
  const affectedAgents = buildAgentRows(related, affectedExecutions);

  // 5. Summary + evidence
  const summary = buildSummary({ related, since, until });
  const evidence: PriorityEvidence[] = priority.reasons;

  return {
    priority,
    signal,
    relatedIncidents: related,
    affectedExecutions,
    affectedAgents,
    evidence,
    summary,
    computedAt,
  };
}

/* Re-export types for convenience. */
export type { IncidentInvestigationView };

/* Re-export unused (but referenced) types so the bundler keeps them. */
export type { IncidentTemporalSummary };
