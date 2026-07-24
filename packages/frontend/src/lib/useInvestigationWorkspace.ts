/**
 * v1.19: Incident Investigation Workspace Hook
 *
 * Composes the four v1.15-v1.18 investigation endpoints (report /
 * actions / narrative / timeline) into a single read-only data hook.
 * Used by InvestigationWorkspace to assemble a five-section view
 * (summary / narrative / timeline / evidence / actions) without
 * each section managing its own fetch lifecycle.
 *
 * Concurrency rules (matches the v1.18 InvestigationReportBlock
 * behaviour, now centralized so the Workspace component stays
 * purely presentational):
 *
 *   - cancelled flag: prevents setState after unmount or after
 *     `incidentKey` changes (race protection).
 *   - error isolation: each endpoint has its own error slot; one
 *     failure does not affect the others. Sections render their own
 *     error / loading / content independently.
 *   - reset on key change: when incidentKey changes, the hook
 *     clears all four data slots so a new incident never renders
 *     stale data from the previous one.
 *
 * Pure frontend hook — no backend change, no DB, no storage.
 */

import { useEffect, useState } from 'react';
import { api } from './api';
import type {
  IncidentInvestigationReportDto,
  IncidentInvestigationNarrativeDto,
  IncidentInvestigationTimelineDto,
  IncidentRecommendedActionBundleDto,
} from './api';

export interface InvestigationWorkspaceData {
  /** v1.15 investigation report (priority + history + evidence). */
  report: IncidentInvestigationReportDto | null;
  reportErr: string | null;
  /** v1.16 recommended actions bundle. */
  actions: IncidentRecommendedActionBundleDto | null;
  actionsErr: string | null;
  /** v1.17 investigation narrative (summary / findings / hypotheses). */
  narrative: IncidentInvestigationNarrativeDto | null;
  narrativeErr: string | null;
  /** v1.18 investigation timeline (ordered events). */
  timeline: IncidentInvestigationTimelineDto | null;
  timelineErr: string | null;
}

const INITIAL: InvestigationWorkspaceData = {
  report: null,
  reportErr: null,
  actions: null,
  actionsErr: null,
  narrative: null,
  narrativeErr: null,
  timeline: null,
  timelineErr: null,
};

export function useInvestigationWorkspace(incidentKey: string): InvestigationWorkspaceData {
  const [data, setData] = useState<InvestigationWorkspaceData>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    // Reset before issuing the new requests so a key change does not
    // momentarily render the previous incident's data.
    setData(INITIAL);

    // Four endpoints are issued in parallel. Each has its own
    // catch handler so one failure cannot affect the others.
    api.incidentReport(incidentKey)
      .then((d) => { if (!cancelled) setData((prev) => ({ ...prev, report: d })); })
      .catch((e) => { if (!cancelled) setData((prev) => ({ ...prev, reportErr: String(e) })); });

    api.incidentActions(incidentKey)
      .then((d) => { if (!cancelled) setData((prev) => ({ ...prev, actions: d })); })
      .catch((e) => { if (!cancelled) setData((prev) => ({ ...prev, actionsErr: String(e) })); });

    api.incidentNarrative(incidentKey)
      .then((d) => { if (!cancelled) setData((prev) => ({ ...prev, narrative: d })); })
      .catch((e) => { if (!cancelled) setData((prev) => ({ ...prev, narrativeErr: String(e) })); });

    api.incidentTimeline(incidentKey)
      .then((d) => { if (!cancelled) setData((prev) => ({ ...prev, timeline: d })); })
      .catch((e) => { if (!cancelled) setData((prev) => ({ ...prev, timelineErr: String(e) })); });

    return () => { cancelled = true; };
  }, [incidentKey]);

  return data;
}