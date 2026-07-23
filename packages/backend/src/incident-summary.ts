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
  IncidentSummary,
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

  return {
    incidentKey: `${first.executionId}|${kind}`,
    executionId: first.executionId,
    kind,
    severity: worst,
    detectedAt,
    lastTransitionAt,
    lifecycle,
    recoveredAt,
    durationMs,
    reason,
  };
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