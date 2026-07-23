/**
 * v1.7 Health Incident Intelligence — pure aggregation.
 *
 * Reads persisted `execution_attention_history` rows filtered to
 * `attention_key = 'investigate-anomaly'` (anomaly-derived incidents)
 * and groups them by (executionId, kind) to build HealthIncident
 * lifecycle rows + a workspace-level IncidentSummary.
 *
 * Pure functions: no DB I/O, no mutations. Caller supplies the
 * already-fetched rows; this module decides grouping, ordering, and
 * what "active" / "recovered" / "top affected" mean.
 *
 * Read-only by design — never writes to DB or mutates inputs.
 */

import type {
  AttentionHistoryEntry,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  HealthIncidentDetail,
  IncidentSeverityChange,
  IncidentSummary,
  IncidentTransition,
} from '@agentos/shared';

/** Filter to anomaly-derived attention entries (umbrella + per-kind). */
const ANOMALY_KEY_PREFIX = 'investigate-anomaly';

function isAnomalyEntry(e: AttentionHistoryEntry): boolean {
  // Matches both the umbrella 'investigate-anomaly' and the v1.7
  // per-kind actions ('investigate-anomaly-score-drop', etc.).
  return e.attentionKey === ANOMALY_KEY_PREFIX || e.attentionKey.startsWith(`${ANOMALY_KEY_PREFIX}-`);
}

/* ---------------- 1. Single incident grouping ---------------- */

/**
 * Reduce one (executionId, kind) slice of anomaly-attention entries
 * into a HealthIncident.
 *
 * Lifecycle rules:
 *   - The latest row's `lifecycle` wins ('detected' / 'ongoing' / 'recovered').
 *   - `detectedAt` = earliest 'detected' row.
 *   - `recoveredAt` = latest 'recovered' row, if any.
 *   - `durationMs` = recoveredAt - detectedAt when both exist.
 *   - `severity` = worst severity across the slice (critical > high).
 *
 * If the slice is empty, returns null.
 */
export function rowsToIncident(rows: AttentionHistoryEntry[]): HealthIncident | null {
  if (rows.length === 0) return null;
  // Defensive: caller may pass a broader slice; filter here.
  const slice = rows.filter(isAnomalyEntry);
  if (slice.length === 0) return null;

  // Sort oldest → newest by id (insertion order).
  const sorted = slice.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const first = sorted[0]!;
  const last  = sorted[sorted.length - 1]!;

  // First 'detected' row (oldest row in lifecycle order is normally detected).
  const detectedRow = sorted.find((r) => r.lifecycle === 'detected') ?? first;
  const recoveredRows = sorted.filter((r) => r.lifecycle === 'recovered');
  const lastRecovered = recoveredRows.length > 0 ? recoveredRows[recoveredRows.length - 1]! : null;

  // Worst severity across the slice.
  let worst: HealthAnomalySeverity = 'high';
  for (const r of sorted) {
    if (r.severity === 'critical') { worst = 'critical'; break; }
  }

  const detectedAt = detectedRow.createdAt;
  const recoveredAt = lastRecovered?.createdAt ?? null;
  const durationMs = recoveredAt
    ? Math.max(0, Date.parse(recoveredAt) - Date.parse(detectedAt))
    : null;

  // Current lifecycle is the latest row's lifecycle.
  const lifecycle = last.lifecycle;
  const lastTransitionAt = last.createdAt;

  // Reason: prefer the detected row's reason, fall back to last row.
  const reason = detectedRow.reason || last.reason;

  // Derive kind: prefer attentionKey (stable across detected/ongoing/recovered
  // rows), fall back to parsing the reason prefix.
  const kind =
    kindFromAttentionKey(first.attentionKey) ??
    kindFromAttentionKey(last.attentionKey) ??
    extractKind(reason);

  // v1.8 severity evolution:
  //   - initialSeverity = first detected row's severity
  //   - maxSeverity = worst across all rows (= `worst` computed above)
  //   - currentSeverity = latest row's severity (recovered rows have 'low',
  //       so a recovered incident's currentSeverity is 'low')
  //   - escalationCount = number of severity upgrades observed
  const initialSeverity = severityOf(detectedRow);
  const currentSeverity = currentSeverityOf(last);
  const escalationCount = countEscalations(sorted);

  return {
    incidentKey: `${first.executionId}|${kind}`,
    executionId: first.executionId,
    kind,
    severity: worst,
    initialSeverity,
    currentSeverity,
    maxSeverity: worst,
    escalationCount,
    detectedAt,
    lastTransitionAt,
    lifecycle,
    recoveredAt,
    durationMs,
    reason,
  };
}

/** Coerce a row's severity to HealthAnomalySeverity (recovered rows are 'low', not a real severity). */
function severityOf(row: AttentionHistoryEntry): HealthAnomalySeverity {
  return row.severity === 'critical' ? 'critical' : 'high';
}

/** Severity for the current/latest row, including 'low' for recovery rows. */
function currentSeverityOf(row: AttentionHistoryEntry): HealthAnomalySeverity | 'low' {
  if (row.lifecycle === 'recovered') return 'low';
  return row.severity === 'critical' ? 'critical' : 'high';
}

/**
 * Count severity upgrades across a chronologically-sorted slice.
 * Severity never downgrades in v1.8 (no rule for that), so each
 * observed upgrade is one step 'high' → 'critical'.
 *
 * Algorithm: walk rows oldest → newest, track currentSeverity, and
 * count every time it transitions to 'critical' (the only allowed
 * upgrade direction). Initial severity ignored (it sets the baseline,
 * not an upgrade event).
 */
function countEscalations(sorted: AttentionHistoryEntry[]): number {
  let count = 0;
  // Track the last *real* (non-recovered) severity to detect transitions.
  let lastRealSeverity: HealthAnomalySeverity | null = null;
  for (const r of sorted) {
    if (r.lifecycle === 'recovered') continue; // recovered rows are 'low', not a real signal
    const s = severityOf(r);
    if (lastRealSeverity === 'high' && s === 'critical') count++;
    lastRealSeverity = s;
  }
  return count;
}

const KIND_PATTERN = /^\[(score-drop|level-regression|rapid-degradation)\]/;
/**
 * Parse the `[kind]` prefix that `anomaliesToAttentionItems` writes
 * into each anomaly-derived attention item's `reason` field.
 *
 * Exported so route handlers can group by (executionId, kind) when
 * they don't have the original anomaly object in hand.
 */
export function extractKind(reason: string): HealthAnomalyKind {
  const m = KIND_PATTERN.exec(reason);
  return (m?.[1] as HealthAnomalyKind | undefined) ?? 'score-drop';
}

/** Maps a per-kind attention_key back to its HealthAnomalyKind. */
function kindFromAttentionKey(attentionKey: string): HealthAnomalyKind | null {
  switch (attentionKey) {
    case 'investigate-anomaly-score-drop':         return 'score-drop';
    case 'investigate-anomaly-level-regression':   return 'level-regression';
    case 'investigate-anomaly-rapid-degradation':  return 'rapid-degradation';
    default: return null;
  }
}

/* ---------------- 2. Workspace summary ---------------- */

/**
 * Build a workspace-level IncidentSummary from one or many slices of
 * anomaly attention rows. Caller supplies the full row set; the
 * function groups, sorts, and counts.
 *
 * `nowMs` is only used for `computedAt` formatting.
 *
 * Pure / read-only.
 */
export function summarizeIncidents(
  rows: AttentionHistoryEntry[],
  opts: { topAffectedLimit?: number; recentRecoveredLimit?: number; nowMs?: number } = {},
): IncidentSummary {
  const topN = opts.topAffectedLimit ?? 5;
  const recentN = opts.recentRecoveredLimit ?? 5;
  const computedAt = new Date(opts.nowMs ?? Date.now()).toISOString();

  const anomalies = rows.filter(isAnomalyEntry);
  // Group by (executionId, kind) via composite key; sort each group
  // oldest → newest by id (rows arrive in insertion order).
  // For each row, the kind is encoded in the attentionKey
  // (e.g. 'investigate-anomaly-score-drop'). Recovered rows reuse
  // the same attentionKey but lose the reason prefix, so the
  // attentionKey is the stable per-kind identifier.
  const groups = new Map<string, AttentionHistoryEntry[]>();
  for (const r of anomalies) {
    const kind = kindFromAttentionKey(r.attentionKey) ?? extractKind(r.reason);
    const key = `${r.executionId}|${kind}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const incidents: HealthIncident[] = [];
  for (const g of groups.values()) {
    const inc = rowsToIncident(g);
    if (inc) incidents.push(inc);
  }

  // Active / recovered split.
  let active = 0;
  let recovered = 0;
  let criticalCount = 0;
  let highCount = 0;
  for (const inc of incidents) {
    if (inc.lifecycle === 'recovered') recovered++;
    else active++;
    if (inc.severity === 'critical') criticalCount++;
    else highCount++;
  }

  // Top affected executions by active incident count, then worst severity.
  const perExec = new Map<string, { activeCount: number; worst: HealthAnomalySeverity }>();
  for (const inc of incidents) {
    if (inc.lifecycle === 'recovered') continue;
    const e = perExec.get(inc.executionId) ?? { activeCount: 0, worst: 'high' as HealthAnomalySeverity };
    e.activeCount++;
    if (inc.severity === 'critical') e.worst = 'critical';
    perExec.set(inc.executionId, e);
  }
  const topAffected = Array.from(perExec.entries())
    .map(([executionId, v]) => ({
      executionId,
      activeCount: v.activeCount,
      worstSeverity: v.worst,
    }))
    .sort((a, b) => b.activeCount - a.activeCount || a.executionId.localeCompare(b.executionId))
    .slice(0, topN);

  // Most recent N recovered, newest first.
  const recentRecovered = incidents
    .filter((i) => i.lifecycle === 'recovered' && i.recoveredAt !== null)
    .sort((a, b) => Date.parse(b.recoveredAt!) - Date.parse(a.recoveredAt!))
    .slice(0, recentN);

  return {
    active,
    recovered,
    criticalCount,
    highCount,
    topAffected,
    recentRecovered,
    computedAt,
  };
}

/* ---------------- 3. Per-incident detail (v1.8) ---------------- */

/**
 * Build a HealthIncidentDetail for one (executionId, kind) pair.
 *
 * Returns null if `rows` is empty or contains no anomaly-derived rows.
 *
 * The returned object extends HealthIncident with:
 *   - `transitions`: chronological list of every state change
 *   - `severityHistory`: every severity upgrade (only high→critical in v1.8)
 *   - `computedAt`: when this detail was computed
 *
 * Pure / read-only.
 */
export function rowsToIncidentDetail(
  rows: AttentionHistoryEntry[],
  opts: { nowMs?: number } = {},
): HealthIncidentDetail | null {
  const anomalies = rows.filter(isAnomalyEntry);
  if (anomalies.length === 0) return null;

  // Group by (executionId, kind) — pick the first matching group.
  // Caller is expected to pass rows for ONE (exec, kind) pair.
  const incident = rowsToIncident(anomalies);
  if (!incident) return null;

  // Chronological transitions (one per row).
  const sorted = anomalies.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const transitions: IncidentTransition[] = sorted.map((r) => ({
    at: r.createdAt,
    lifecycle: r.lifecycle,
    // Recovery rows are severity 'low' but we surface that explicitly.
    severity: r.lifecycle === 'recovered' ? 'low' : r.severity === 'critical' ? 'critical' : 'high',
    reason: r.reason,
  }));

  // Severity upgrade history.
  const severityHistory: IncidentSeverityChange[] = [];
  let lastRealSeverity: HealthAnomalySeverity | null = null;
  for (const r of sorted) {
    if (r.lifecycle === 'recovered') continue;
    const s = severityOf(r);
    if (lastRealSeverity === 'high' && s === 'critical') {
      severityHistory.push({
        at: r.createdAt,
        from: 'high',
        to: 'critical',
        reason: 'Anomaly fired with critical severity (e.g. large score drop or critical-level regression)',
      });
    }
    lastRealSeverity = s;
  }

  return {
    ...incident,
    transitions,
    severityHistory,
    computedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
  };
}

/**
 * Group attention rows by (executionId, kind) and build a detail
 * for each group. Returns a map keyed by incidentKey.
 *
 * Useful for the route handler that needs to look up one specific
 * incident by key without re-grouping the whole attention history.
 */
export function buildAllIncidentDetails(
  rows: AttentionHistoryEntry[],
  opts: { nowMs?: number } = {},
): Map<string, HealthIncidentDetail> {
  const anomalies = rows.filter(isAnomalyEntry);
  const groups = new Map<string, AttentionHistoryEntry[]>();
  for (const r of anomalies) {
    const kind = kindFromAttentionKey(r.attentionKey) ?? extractKind(r.reason);
    const key = `${r.executionId}|${kind}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, HealthIncidentDetail>();
  for (const [key, g] of groups.entries()) {
    const d = rowsToIncidentDetail(g, opts);
    if (d) out.set(key, d);
  }
  return out;
}