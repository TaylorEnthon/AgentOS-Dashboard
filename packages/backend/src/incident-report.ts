/**
 * v1.15: Incident Investigation Report — pure aggregation module.
 *
 * Bundles the three per-incident views built by previous versions:
 *   - v1.12 IncidentInvestigationView
 *   - v1.13 IncidentHistoricalContext
 *   - v1.14 IncidentRootCauseEvidence
 *
 * This module does NOT recompute any of the three views. It is purely
 * a packager that ensures all three are present and pairs them with
 * an aggregation timestamp.
 *
 * Pure / read-only / deterministic. Operates entirely on caller-injected
 * data — no DB, no globals, no Date.now() (a `nowIso` is required and
 * threaded through to `generatedAt`).
 */

import type {
  IncidentHistoricalContext,
  IncidentInvestigationReport,
  IncidentInvestigationView,
  IncidentRootCauseEvidence,
} from '@agentos/shared';

export interface BuildReportArgs {
  /** The incidentKey this report is for. */
  incidentKey: string;
  /** v1.12 view (or null when no matching priority exists). */
  investigation: IncidentInvestigationView | null;
  /** v1.13 context (or null when current incident is not in pool). */
  history: IncidentHistoricalContext | null;
  /** v1.14 evidence (or null when current incident is not in pool). */
  evidence: IncidentRootCauseEvidence | null;
  /** ISO timestamp for `generatedAt`. Required for determinism. */
  nowIso: string;
}

/**
 * Assemble a unified investigation report from three pre-computed views.
 *
 * Returns `null` when ANY of the three views is null:
 *   - investigation === null → no matching priority in the current snapshot
 *   - history       === null → current incident not in pool / invalid key
 *   - evidence      === null → current incident not in pool / invalid key
 *
 * Otherwise returns a fully populated IncidentInvestigationReport with
 * `generatedAt` set to `nowIso`. This is a pure pass-through: no field
 * of any input view is mutated.
 */
export function buildInvestigationReport(args: BuildReportArgs): IncidentInvestigationReport | null {
  const { investigation, history, evidence, nowIso, incidentKey } = args;
  if (!investigation || !history || !evidence) return null;
  return {
    incidentKey,
    investigation,
    history,
    evidence,
    generatedAt: nowIso,
  };
}