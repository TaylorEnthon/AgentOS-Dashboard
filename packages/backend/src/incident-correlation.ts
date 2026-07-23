/**
 * v1.9: Incident Intelligence & Correlation — pure-function module.
 *
 * Derives cross-incident intelligence from a list of HealthIncident rows:
 *   - ExecutionIncidentInsight  — per-execution aggregation
 *   - AgentIncidentInsight      — per-agent aggregation
 *   - KindIncidentInsight       — per-kind aggregation
 *   - IncidentCorrelation[]     — cross-cutting patterns (agent / kind / agent-kind)
 *   - IncidentCorrelationSummary — workspace rollup
 *
 * All functions are pure: no DB I/O, no mutations. The caller supplies:
 *   - the HealthIncident list (from rowsToIncident / rowsToIncidentDetail)
 *   - an executionId → AgentType map (built via db.getSession / agent_id parsing)
 *
 * Deterministic: same input → same output. No ML, no external services.
 *
 * Read-only by design — never writes to DB or mutates inputs.
 */

import type {
  AgentIncidentInsight,
  AgentType,
  ExecutionIncidentInsight,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentCorrelation,
  IncidentCorrelationSummary,
  KindIncidentInsight,
} from '@agentos/shared';

/* ---------------- 1. Per-execution aggregation ---------------- */

/**
 * Group HealthIncident[] by executionId and aggregate.
 * Pure / read-only.
 */
export function aggregateByExecution(incidents: HealthIncident[]): ExecutionIncidentInsight[] {
  const byExec = new Map<string, HealthIncident[]>();
  for (const inc of incidents) {
    const arr = byExec.get(inc.executionId);
    if (arr) arr.push(inc);
    else byExec.set(inc.executionId, [inc]);
  }
  const out: ExecutionIncidentInsight[] = [];
  for (const [executionId, list] of byExec.entries()) {
    out.push(toExecutionInsight(executionId, list));
  }
  // Sort: most incidents first, then by worst severity, then by name.
  out.sort((a, b) => b.incidents - a.incidents || sevRank(b.worstSeverity) - sevRank(a.worstSeverity) || a.executionId.localeCompare(b.executionId));
  return out;
}

function toExecutionInsight(executionId: string, list: HealthIncident[]): ExecutionIncidentInsight {
  const kinds = Array.from(new Set(list.map((i) => i.kind)));
  let active = 0;
  let recovered = 0;
  let worst: HealthAnomalySeverity = 'high';
  let totalEscalations = 0;
  let lastTransitionAt: string | null = null;
  for (const inc of list) {
    if (inc.lifecycle === 'recovered') recovered++;
    else active++;
    if (inc.severity === 'critical') worst = 'critical';
    totalEscalations += inc.escalationCount;
    if (lastTransitionAt === null || Date.parse(inc.lastTransitionAt ?? inc.detectedAt) > Date.parse(lastTransitionAt)) {
      lastTransitionAt = inc.lastTransitionAt ?? inc.detectedAt;
    }
  }
  return {
    executionId,
    kinds,
    incidents: list.length,
    active,
    recovered,
    worstSeverity: worst,
    totalEscalations,
    lastTransitionAt,
  };
}

/* ---------------- 2. Per-agent aggregation ---------------- */

/**
 * Group by AgentType. Caller supplies executionId → AgentType map.
 * Pure / read-only.
 */
export function aggregateByAgent(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
): AgentIncidentInsight[] {
  const byAgent = new Map<string, HealthIncident[]>();
  const execsByAgent = new Map<string, Set<string>>();
  for (const inc of incidents) {
    const agent = executionToAgent.get(inc.executionId);
    if (!agent) continue; // skip if we don't know the agent
    let arr = byAgent.get(agent);
    if (!arr) { arr = []; byAgent.set(agent, arr); }
    arr.push(inc);
    let set = execsByAgent.get(agent);
    if (!set) { set = new Set(); execsByAgent.set(agent, set); }
    set.add(inc.executionId);
  }
  const out: AgentIncidentInsight[] = [];
  for (const [agentType, list] of byAgent.entries()) {
    let active = 0, recovered = 0;
    let criticalCount = 0, highCount = 0;
    let worst: HealthAnomalySeverity = 'high';
    let totalEscalations = 0;
    let lastTransitionAt: string | null = null;
    for (const inc of list) {
      if (inc.lifecycle === 'recovered') recovered++;
      else active++;
      if (inc.severity === 'critical') { worst = 'critical'; criticalCount++; }
      else highCount++;
      totalEscalations += inc.escalationCount;
      if (lastTransitionAt === null || Date.parse(inc.lastTransitionAt ?? inc.detectedAt) > Date.parse(lastTransitionAt)) {
        lastTransitionAt = inc.lastTransitionAt ?? inc.detectedAt;
      }
    }
    out.push({
      agentType,
      affectedExecutions: execsByAgent.get(agentType)?.size ?? 0,
      incidentCount: list.length,
      active,
      recovered,
      criticalCount,
      highCount,
      totalEscalations,
      worstSeverity: worst,
      lastTransitionAt,
    });
  }
  // Sort: most incidents first, then by worst severity.
  out.sort((a, b) => b.incidentCount - a.incidentCount || sevRank(b.worstSeverity) - sevRank(a.worstSeverity) || a.agentType.localeCompare(b.agentType));
  return out;
}

/* ---------------- 3. Per-kind aggregation ---------------- */

export function aggregateByKind(incidents: HealthIncident[]): KindIncidentInsight[] {
  const byKind = new Map<HealthAnomalyKind, HealthIncident[]>();
  for (const inc of incidents) {
    const arr = byKind.get(inc.kind);
    if (arr) arr.push(inc);
    else byKind.set(inc.kind, [inc]);
  }
  const out: KindIncidentInsight[] = [];
  for (const [kind, list] of byKind.entries()) {
    let active = 0, recovered = 0;
    let criticalCount = 0, highCount = 0;
    let totalEscalations = 0;
    let lastTransitionAt: string | null = null;
    const execs = new Set<string>();
    for (const inc of list) {
      if (inc.lifecycle === 'recovered') recovered++;
      else active++;
      if (inc.severity === 'critical') criticalCount++;
      else highCount++;
      totalEscalations += inc.escalationCount;
      execs.add(inc.executionId);
      if (lastTransitionAt === null || Date.parse(inc.lastTransitionAt ?? inc.detectedAt) > Date.parse(lastTransitionAt)) {
        lastTransitionAt = inc.lastTransitionAt ?? inc.detectedAt;
      }
    }
    out.push({
      kind,
      incidentCount: list.length,
      active,
      recovered,
      criticalCount,
      highCount,
      affectedExecutions: execs.size,
      totalEscalations,
      lastTransitionAt,
    });
  }
  // Sort: most incidents first.
  out.sort((a, b) => b.incidentCount - a.incidentCount || a.kind.localeCompare(b.kind));
  return out;
}

/* ---------------- 4. Cross-cutting correlation ---------------- */

/**
 * Build correlation patterns from a HealthIncident list.
 *
 * Returns three dimensions:
 *   - 'agent'         — `agent:${AgentType}` — incidents grouped by agent
 *   - 'kind'          — `kind:${HealthAnomalyKind}` — incidents grouped by kind
 *   - 'agent-kind'    — `agent:${AgentType}:kind:${kind}` — both axes
 *
 * Each correlation captures: incidentCount, active vs recovered,
 * worst severity, dominant kind (per-agent), degradation frequency
 * (incidents per affected execution, ≥ 1.0).
 */
export function buildCorrelations(
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: { nowMs?: number } = {},
): IncidentCorrelation[] {
  if (incidents.length === 0) return [];
  const computedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  const out: IncidentCorrelation[] = [];

  // ---- by-agent ----
  const byAgent = new Map<string, HealthIncident[]>();
  for (const inc of incidents) {
    const a = executionToAgent.get(inc.executionId);
    if (!a) continue;
    let arr = byAgent.get(a);
    if (!arr) { arr = []; byAgent.set(a, arr); }
    arr.push(inc);
  }
  for (const [agentType, list] of byAgent.entries()) {
    const execs = new Set(list.map((i) => i.executionId));
    const dominantKind = pickDominantKind(list);
    const corr: IncidentCorrelation = {
      correlationKey: `agent:${agentType}`,
      dimension: 'agent',
      status: list.some((i) => i.lifecycle !== 'recovered') ? 'active' : 'mixed',
      affectedExecutions: execs.size,
      affectedAgents: [agentType],
      incidentCount: list.length,
      activeCount: list.filter((i) => i.lifecycle !== 'recovered').length,
      recoveredCount: list.filter((i) => i.lifecycle === 'recovered').length,
      worstSeverity: worstSeverityOf(list),
      dominantKind,
      degradationFrequency: list.length / execs.size,
      lastTransitionAt: latestTransition(list),
      agentType,
    };
    out.push(corr);
  }

  // ---- by-kind ----
  const byKind = new Map<HealthAnomalyKind, HealthIncident[]>();
  for (const inc of incidents) {
    let arr = byKind.get(inc.kind);
    if (!arr) { arr = []; byKind.set(inc.kind, arr); }
    arr.push(inc);
  }
  for (const [kind, list] of byKind.entries()) {
    const execs = new Set(list.map((i) => i.executionId));
    const corr: IncidentCorrelation = {
      correlationKey: `kind:${kind}`,
      dimension: 'kind',
      status: list.some((i) => i.lifecycle !== 'recovered') ? 'active' : 'mixed',
      affectedExecutions: execs.size,
      affectedAgents: Array.from(new Set(list.map((i) => executionToAgent.get(i.executionId)).filter((x): x is string => Boolean(x)))),
      incidentCount: list.length,
      activeCount: list.filter((i) => i.lifecycle !== 'recovered').length,
      recoveredCount: list.filter((i) => i.lifecycle === 'recovered').length,
      worstSeverity: worstSeverityOf(list),
      dominantKind: kind,
      degradationFrequency: list.length / execs.size,
      lastTransitionAt: latestTransition(list),
      kind,
    };
    out.push(corr);
  }

  // ---- by-agent-kind (only when both axes are known) ----
  const byAgentKind = new Map<string, { agentType: string; kind: HealthAnomalyKind; list: HealthIncident[] }>();
  for (const inc of incidents) {
    const a = executionToAgent.get(inc.executionId);
    if (!a) continue;
    const key = `${a}|${inc.kind}`;
    let entry = byAgentKind.get(key);
    if (!entry) { entry = { agentType: a, kind: inc.kind, list: [] }; byAgentKind.set(key, entry); }
    entry.list.push(inc);
  }
  for (const { agentType, kind, list } of byAgentKind.values()) {
    const execs = new Set(list.map((i) => i.executionId));
    const corr: IncidentCorrelation = {
      correlationKey: `agent:${agentType}:kind:${kind}`,
      dimension: 'agent-kind',
      status: list.some((i) => i.lifecycle !== 'recovered') ? 'active' : 'mixed',
      affectedExecutions: execs.size,
      affectedAgents: [agentType],
      incidentCount: list.length,
      activeCount: list.filter((i) => i.lifecycle !== 'recovered').length,
      recoveredCount: list.filter((i) => i.lifecycle === 'recovered').length,
      worstSeverity: worstSeverityOf(list),
      dominantKind: kind,
      degradationFrequency: list.length / execs.size,
      lastTransitionAt: latestTransition(list),
      agentType,
      kind,
    };
    out.push(corr);
  }
  // Suppress unused-variable linter when computedAt is implicit.
  void computedAt;
  return out;
}

/**
 * Build the workspace-level correlation summary.
 */
export function buildCorrelationSummary(
  correlations: IncidentCorrelation[],
  incidents: HealthIncident[],
  executionToAgent: Map<string, string>,
  opts: { nowMs?: number } = {},
): IncidentCorrelationSummary {
  const computedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  let totalActive = 0, totalRecovered = 0;
  for (const inc of incidents) {
    if (inc.lifecycle === 'recovered') totalRecovered++;
    else totalActive++;
  }
  const affectedAgents = new Set<string>();
  const affectedExecutions = new Set<string>();
  for (const inc of incidents) {
    affectedExecutions.add(inc.executionId);
    const a = executionToAgent.get(inc.executionId);
    if (a) affectedAgents.add(a);
  }
  // Top agent / top kind by incident count (across the agent / kind dimensions).
  const topAgent = correlations
    .filter((c) => c.dimension === 'agent')
    .sort((a, b) => b.incidentCount - a.incidentCount)[0]?.agentType ?? null;
  const topKind = correlations
    .filter((c) => c.dimension === 'kind')
    .sort((a, b) => b.incidentCount - a.incidentCount)[0]?.kind ?? null;
  return {
    correlations,
    totalActive,
    totalRecovered,
    affectedAgentCount: affectedAgents.size,
    affectedExecutionCount: affectedExecutions.size,
    topAgent,
    topKind,
    computedAt,
  };
}

/* ---------------- 5. Helpers ---------------- */

function sevRank(s: HealthAnomalySeverity): number {
  return s === 'critical' ? 2 : 1;
}

function worstSeverityOf(list: HealthIncident[]): HealthAnomalySeverity {
  let worst: HealthAnomalySeverity = 'high';
  for (const inc of list) {
    if (inc.severity === 'critical') return 'critical';
    worst = 'high';
  }
  return worst;
}

function pickDominantKind(list: HealthIncident[]): HealthAnomalyKind {
  const counts = new Map<HealthAnomalyKind, number>();
  for (const inc of list) counts.set(inc.kind, (counts.get(inc.kind) ?? 0) + 1);
  let bestKind: HealthAnomalyKind = list[0]!.kind;
  let bestCount = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) { bestKind = k; bestCount = c; }
  }
  return bestKind;
}

function latestTransition(list: HealthIncident[]): string | null {
  let best: string | null = null;
  for (const inc of list) {
    const t = inc.lastTransitionAt ?? inc.detectedAt;
    if (best === null || Date.parse(t) > Date.parse(best)) best = t;
  }
  return best;
}

/* ---------------- 6. executionId → agentType helper ---------------- */

/**
 * Build an executionId → AgentType map from a list of sessions.
 * Pure / read-only; assumes SessionRow-like shape with `id` and `agent_id`.
 *
 * agent_id is conventionally `${AgentType}:${externalId}` for stored
 * sessions; this helper extracts the AgentType prefix.
 */
export function buildExecutionToAgentMap(
  sessions: Array<{ id: string; agent_id: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions) {
    const agentType = (s.agent_id.split(':')[0] ?? 'unknown') as AgentType;
    if (!out.has(s.id)) out.set(s.id, agentType);
  }
  return out;
}