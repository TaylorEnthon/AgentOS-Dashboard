/**
 * v1.20: Incident Investigation Workspace Hook
 *
 * Composes the four v1.15-v1.18 investigation endpoints (report /
 * actions / narrative / timeline) into a single read-only data hook.
 * Used by InvestigationWorkspace to assemble a five-section view
 * (summary / narrative / timeline / evidence / actions) without
 * each section managing its own fetch lifecycle.
 *
 * Lifecycle (v1.20 refinement):
 *
 *   - AbortController: every effect run creates a fresh controller
 *     and threads its `signal` through the four endpoint wrappers.
 *     On cleanup (unmount or incidentKey change), the controller is
 *     aborted so in-flight fetches are cancelled by the browser, not
 *     merely discarded after the fact. This eliminates the "fetch
 *     leak" risk when a user rapidly switches between incidents.
 *
 *   - cancelled flag: belt-and-braces. Even if the browser does not
 *     honour the abort signal in some edge case (older engine, test
 *     harness), the flag prevents setState after teardown.
 *
 *   - AbortError swallow: an aborted fetch rejects with DOMException
 *     name='AbortError'. That is the EXPECTED end-state for the
 *     previous incident's requests, not a section error. We swallow
 *     AbortError specifically; all other errors are surfaced into the
 *     matching `*Err` slot for the section to display.
 *
 *   - error isolation: each endpoint has its own error slot; one
 *     failure does not affect the others. Sections render their own
 *     error / loading / content independently.
 *
 *   - reset on key change: when incidentKey changes, the hook
 *     clears all four data slots so a new incident never renders
 *     stale data from the previous one.
 *
 * State model: a single `InvestigationWorkspaceData` object holding
 * each endpoint's `(data, err)` pair.
 *
 * Pure frontend hook — no backend change, no DB, no storage, no cache.
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

/** Returns true when the given thrown value is a fetch AbortError. */
function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (typeof e === 'object' && e !== null && 'name' in e) {
    return (e as { name?: string }).name === 'AbortError';
  }
  return false;
}

export function useInvestigationWorkspace(incidentKey: string): InvestigationWorkspaceData {
  const [data, setData] = useState<InvestigationWorkspaceData>(INITIAL);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let cancelled = false;

    // Reset before issuing the new requests so a key change does not
    // momentarily render the previous incident's data.
    setData(INITIAL);

    // Four endpoints issued in parallel. Each is cancelled when
    // `signal` aborts (unmount / incidentKey change) and is
    // individually error-isolated.
    api.incidentReport(incidentKey, signal)
      .then((d) => {
        if (cancelled || signal.aborted) return;
        setData((prev) => ({ ...prev, report: d }));
      })
      .catch((e: unknown) => {
        if (cancelled || signal.aborted || isAbortError(e)) return;
        setData((prev) => ({ ...prev, reportErr: String(e) }));
      });

    api.incidentActions(incidentKey, signal)
      .then((d) => {
        if (cancelled || signal.aborted) return;
        setData((prev) => ({ ...prev, actions: d }));
      })
      .catch((e: unknown) => {
        if (cancelled || signal.aborted || isAbortError(e)) return;
        setData((prev) => ({ ...prev, actionsErr: String(e) }));
      });

    api.incidentNarrative(incidentKey, signal)
      .then((d) => {
        if (cancelled || signal.aborted) return;
        setData((prev) => ({ ...prev, narrative: d }));
      })
      .catch((e: unknown) => {
        if (cancelled || signal.aborted || isAbortError(e)) return;
        setData((prev) => ({ ...prev, narrativeErr: String(e) }));
      });

    api.incidentTimeline(incidentKey, signal)
      .then((d) => {
        if (cancelled || signal.aborted) return;
        setData((prev) => ({ ...prev, timeline: d }));
      })
      .catch((e: unknown) => {
        if (cancelled || signal.aborted || isAbortError(e)) return;
        setData((prev) => ({ ...prev, timelineErr: String(e) }));
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [incidentKey]);

  return data;
}