/**
 * v1.18: Incident Investigation Timeline — pure-function module.
 *
 * Given a populated IncidentInvestigationReport (v1.15), generates an
 * ordered timeline of lifecycle events for a single HealthIncident.
 *
 * Event sources (all deterministic, all from existing report fields):
 *   - 'detected'   ← current.detectedAt (always, if current exists)
 *   - 'escalated'  ← current.escalationCount > 0
 *   - 'recovered'  ← current.lifecycle === 'recovered' && current.recoveredAt != null
 *   - 'recurred'   ← one event per entry in report.history.previousIncidents
 *
 * Ordering: timestamp ASC, type ASC (stable tie-break for same-timestamp
 * events). All message strings are template-composed from report fields
 * — no LLM, no ML, no I/O.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-injected
 * data — no DB, no globals, no Date.now() (nowIso is required and
 * threaded through to `generatedAt`).
 */

import type {
  HealthIncident,
  IncidentHistoricalContext,
  IncidentInvestigationReport,
  IncidentInvestigationTimeline,
  IncidentInvestigationTimelineEvent,
  IncidentInvestigationTimelineEventType,
} from '@agentos/shared';

/**
 * Maximum number of timeline events to return. Caps the per-incident
 * `recurred` explosion when an incident kind has fired many times.
 * The pool is bounded by retention upstream; 100 is well above the
 * "investigation context" sweet spot.
 */
const MAX_TIMELINE_EVENTS = 100;

/* ---------------- helpers ---------------- */

function fmtMs(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function eventComparator(
  a: IncidentInvestigationTimelineEvent,
  b: IncidentInvestigationTimelineEvent,
): number {
  // Primary: timestamp ASC.
  const t = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (t !== 0) return t;
  // Stable tie-break: type ASC (alphabetical).
  return a.type.localeCompare(b.type);
}

/* ---------------- per-rule builders ---------------- */

function detectedEvent(current: HealthIncident): IncidentInvestigationTimelineEvent {
  return {
    timestamp: current.detectedAt,
    type: 'detected',
    message: `${current.kind} incident detected on execution ${current.executionId}.`,
  };
}

function escalatedEvent(current: HealthIncident): IncidentInvestigationTimelineEvent | null {
  if (current.escalationCount <= 0) return null;
  // Use lastTransitionAt if available (this is when the latest escalation
  // row was written); otherwise fall back to detectedAt as a defensive
  // approximation. The HealthIncident collapses all severity-upgrade
  // transitions into a single count + lastTransitionAt timestamp.
  const ts = current.lastTransitionAt ?? current.detectedAt;
  return {
    timestamp: ts,
    type: 'escalated',
    message:
      current.escalationCount === 1
        ? `Severity escalated to ${current.maxSeverity}.`
        : `Severity escalated to ${current.maxSeverity} (${current.escalationCount} escalation(s) during lifetime).`,
  };
}

function recoveredEvent(current: HealthIncident): IncidentInvestigationTimelineEvent | null {
  if (current.lifecycle !== 'recovered' || current.recoveredAt === null) return null;
  return {
    timestamp: current.recoveredAt,
    type: 'recovered',
    message:
      current.durationMs !== null
        ? `Incident recovered after ${fmtMs(current.durationMs)}.`
        : 'Incident recovered.',
  };
}

function recurredEvents(
  current: HealthIncident,
  history: IncidentHistoricalContext,
): IncidentInvestigationTimelineEvent[] {
  // "recurred" is one event per prior occurrence of the same kind,
  // listed in chronological order so the UI can show "this kind has
  // happened before, going back to <date>".
  if (history.previousIncidents.length === 0) return [];
  const total = history.occurrenceCount;
  // previousIncidents is sorted by detectedAt DESC (v1.13 history module).
  // We want ASC for timeline display, so reverse + map.
  const asc = history.previousIncidents
    .slice()
    .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));
  return asc.map((prev) => ({
    timestamp: prev.detectedAt,
    type: 'recurred',
    message:
      prev.kind === current.kind
        ? `${prev.kind} recurred (occurrence #${total} of ${total} across all matching incidents).`
        : `${prev.kind} recurred (related prior incident; total ${current.kind} occurrences: ${total}).`,
  }));
}

/* ---------------- main entry point ---------------- */

export interface BuildTimelineArgs {
  /** Full IncidentInvestigationReport (v1.15) — caller-supplied. */
  report: IncidentInvestigationReport | null;
  /** ISO timestamp for `generatedAt`. Required for determinism. */
  nowIso: string;
}

/**
 * Build the ordered investigation timeline for a single incident.
 *
 * Returns `null` only when `report` itself is null (route should map
 * to 404). Otherwise returns a populated bundle with zero or more
 * events, ordered by timestamp ASC (then type ASC).
 *
 * The function never throws; it returns a 0-event bundle when the
 * current incident has no detectable lifecycle data (e.g. a degraded
 * pool where `current.detectedAt` is missing).
 *
 * Pure / read-only / deterministic. Operates entirely on caller-
 * injected data — no DB, no globals, no Date.now().
 */
export function buildInvestigationTimeline(
  args: BuildTimelineArgs,
): IncidentInvestigationTimeline | null {
  if (!args.report) return null;
  const report = args.report;
  const nowIso = args.nowIso;
  const investigation = report.investigation;
  const history = report.history;

  // The investigation view's relatedIncidents contains the current
  // (since the priority's signal subjectKey matches). Find the
  // HealthIncident that has the same incidentKey as the report.
  const current = investigation.relatedIncidents.find(
    (i) => i.incidentKey === report.incidentKey,
  );
  if (!current) {
    // No current found — emit an empty timeline.
    return { incidentKey: report.incidentKey, events: [], generatedAt: nowIso };
  }

  const events: IncidentInvestigationTimelineEvent[] = [];

  // 1) Detected (always)
  events.push(detectedEvent(current));

  // 2) Escalated (if applicable)
  const esc = escalatedEvent(current);
  if (esc) events.push(esc);

  // 3) Recovered (if applicable)
  const rec = recoveredEvent(current);
  if (rec) events.push(rec);

  // 4) Recurred (one per prior occurrence, up to MAX_TIMELINE_EVENTS cap)
  const recurred = recurredEvents(current, history);
  for (const r of recurred) {
    if (events.length >= MAX_TIMELINE_EVENTS) break;
    events.push(r);
  }

  // Stable ordering: timestamp ASC, type ASC.
  events.sort(eventComparator);

  return {
    incidentKey: report.incidentKey,
    events,
    generatedAt: nowIso,
  };
}