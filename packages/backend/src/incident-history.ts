/**
 * v1.13: Incident Historical Context — pure-function module.
 *
 * Given a current HealthIncident identified by `incidentKey`
 * (format `${executionId}|${kind}`), aggregates historical metrics
 * over every HealthIncident in the supplied pool with the SAME kind,
 * answering:
 *   - how many of this kind have we seen? (occurrenceCount)
 *   - how often does this kind recover? (recoveredCount)
 *   - how long does recovery typically take? (averageDurationMs / maxDurationMs)
 *   - when did we first / last see this kind? (firstSeen / lastSeen)
 *   - does this kind recur with severity upgrades? (recurrenceRate)
 *   - what came before the current one? (previousIncidents)
 *
 * Pure / read-only / deterministic. Operates entirely on
 * HealthIncident[] injected by the caller — no DB, no globals,
 * no Date.now() (a `nowIso` is required and threaded through).
 */

import type {
  HealthAnomalyKind,
  HealthIncident,
  IncidentHistoricalContext,
} from '@agentos/shared';

/**
 * Maximum number of `previousIncidents` returned to keep payloads
 * bounded for the UI. The pool is bounded by retention upstream;
 * 50 is well above the "investigation context" sweet spot.
 */
const PREVIOUS_INCIDENTS_CAP = 50;

/**
 * Parse `incidentKey` into its two parts.
 * Returns null when the format is invalid — callers should map this
 * to a 400 Bad Request at the route layer.
 */
export function parseIncidentKey(incidentKey: string): { executionId: string; kind: HealthAnomalyKind } | null {
  const idx = incidentKey.lastIndexOf('|');
  if (idx <= 0 || idx >= incidentKey.length - 1) return null;
  const executionId = incidentKey.slice(0, idx);
  const kind = incidentKey.slice(idx + 1) as HealthAnomalyKind;
  if (kind !== 'score-drop' && kind !== 'level-regression' && kind !== 'rapid-degradation') {
    return null;
  }
  if (!executionId) return null;
  return { executionId, kind };
}

/**
 * Compute IncidentHistoricalContext for an incidentKey.
 *
 * @param args.incidentKey     The current incident's key (`${executionId}|${kind}`)
 * @param args.allIncidents    Pool of HealthIncidents — typically the result of
 *                             `collectAllIncidents()` at the route layer. Scope is
 *                             "all incidents the system has ever seen this session".
 * @param args.nowIso          ISO timestamp for `computedAt`. Required to keep the
 *                             function deterministic (no Date.now() call).
 *
 * Returns `null` when:
 *   - incidentKey format is invalid (route → 400)
 *   - the current incident is not in the pool (route → 404)
 *
 * Returns a populated IncidentHistoricalContext otherwise.
 * Empty pools yield a context with `occurrenceCount: 0`, all metrics null,
 * and `hasHistory: false` (only possible if current isn't found).
 */
export function buildHistoricalContext(args: {
  incidentKey: string;
  allIncidents: HealthIncident[];
  nowIso: string;
}): IncidentHistoricalContext | null {
  const parsed = parseIncidentKey(args.incidentKey);
  if (!parsed) return null;
  const { kind, executionId } = parsed;
  const { allIncidents, nowIso } = args;

  // 1. Locate the current incident in the pool.
  const current = allIncidents.find((i) => i.incidentKey === args.incidentKey);
  if (!current) return null;

  // 2. Scope: same-kind incidents across all executions.
  const matched = allIncidents.filter((i) => i.kind === kind);

  // 3. Aggregations.
  let recoveredCount = 0;
  let escalatedCount = 0;
  let durationSum = 0;
  let durationCount = 0;
  let maxDurationMs: number | null = null;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  for (const inc of matched) {
    if (inc.lifecycle === 'recovered') recoveredCount++;
    if (inc.escalationCount > 0) escalatedCount++;
    if (inc.durationMs !== null && inc.durationMs > 0) {
      durationSum += inc.durationMs;
      durationCount += 1;
      if (maxDurationMs === null || inc.durationMs > maxDurationMs) {
        maxDurationMs = inc.durationMs;
      }
    }
    if (firstSeen === null || Date.parse(inc.detectedAt) < Date.parse(firstSeen)) {
      firstSeen = inc.detectedAt;
    }
    const candidateLast = inc.lastTransitionAt ?? inc.detectedAt;
    if (lastSeen === null || Date.parse(candidateLast) > Date.parse(lastSeen)) {
      lastSeen = candidateLast;
    }
  }

  const averageDurationMs =
    durationCount > 0 ? Math.round(durationSum / durationCount) : null;

  const recurrenceRate = matched.length > 0 ? escalatedCount / matched.length : 0;

  // 4. previousIncidents = matched \ current, sorted by detectedAt DESC,
  //    capped at PREVIOUS_INCIDENTS_CAP.
  const previousIncidents = matched
    .filter((i) => i.incidentKey !== args.incidentKey)
    .slice()
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
    .slice(0, PREVIOUS_INCIDENTS_CAP);

  return {
    incidentKey: args.incidentKey,
    kind,
    executionId,
    occurrenceCount: matched.length,
    recoveredCount,
    averageDurationMs,
    maxDurationMs,
    firstSeen,
    lastSeen,
    recurrenceRate,
    previousIncidents,
    hasHistory: matched.length > 0,
    computedAt: nowIso,
  };
}