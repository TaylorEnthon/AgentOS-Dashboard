/**
 * v1.20: useInvestigationWorkspace hook tests.
 *
 * Covers the four contract guarantees:
 *
 *   1. Initial state — all four slots are { null, null }.
 *   2. Success — four endpoints fill their slots in parallel.
 *   3. Error isolation — one failed endpoint does not affect the others.
 *   4. incidentKey change — slot reset + re-fetch; the previous fetch
 *      is cancelled (AbortError is swallowed, never surfaced).
 *
 * Strategy: stub `api.*` via vi.mock so we observe call counts and
 * return shapes without hitting the network. Each test waits for
 * the relevant Promise microtasks with `await waitFor` so React's
 * scheduled state updates flush before assertions.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { api } from '../lib/api';
import type {
  IncidentInvestigationReportDto,
  IncidentInvestigationNarrativeDto,
  IncidentInvestigationTimelineDto,
  IncidentRecommendedActionBundleDto,
  IncidentPriorityInsightDto,
  IncidentInvestigationViewDto,
  IncidentHistoricalContextDto,
  IncidentRootCauseEvidenceDto,
  RootCauseEvidenceItemDto,
  IntelligenceSignalDto,
  PriorityEvidenceDto,
} from '../lib/api';
import { useInvestigationWorkspace } from '../lib/useInvestigationWorkspace';

// --- Module mock -----------------------------------------------------------
//
// We replace the four endpoint methods on the `api` object so each test
// can configure them with vi.mocked(...).mockResolvedValueOnce(...) etc.
// Other api methods are left untouched (we never call them from this hook).

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      incidentReport: vi.fn(),
      incidentActions: vi.fn(),
      incidentNarrative: vi.fn(),
      incidentTimeline: vi.fn(),
    },
  };
});

const mockedApi = api as unknown as {
  incidentReport: ReturnType<typeof vi.fn>;
  incidentActions: ReturnType<typeof vi.fn>;
  incidentNarrative: ReturnType<typeof vi.fn>;
  incidentTimeline: ReturnType<typeof vi.fn>;
};

// --- Fixture factories -----------------------------------------------------
//
// Each factory returns a fully-typed DTO with the minimum required
// fields. Tests compose them by spreading overrides.

function makePriority(overrides: Partial<IncidentPriorityInsightDto> = {}): IncidentPriorityInsightDto {
  return {
    priorityId: 'score-drop:exec-1',
    signalKind: 'kind-surge',
    signalSeverity: 'warn',
    subjectKey: 'exec-1',
    signalId: 'kind-surge:exec-1',
    signalScore: 3,
    signalThreshold: 2,
    signalDescription: 'kind-surge observed',
    since: '2026-07-23T22:00:00.000Z',
    until: '2026-07-24T02:00:00.000Z',
    priorityScore: 80,
    priorityLevel: 'high',
    reasons: [],
    trendHint: null,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<IntelligenceSignalDto> = {}): IntelligenceSignalDto {
  return {
    signalId: 'kind-surge:exec-1',
    kind: 'kind-surge',
    severity: 'warn',
    subjectKey: 'exec-1',
    since: '2026-07-23T22:00:00.000Z',
    until: '2026-07-24T02:00:00.000Z',
    score: 3,
    threshold: 2,
    description: 'kind-surge observed',
    ...overrides,
  };
}

const EMPTY_EVIDENCE_CHAIN: PriorityEvidenceDto[] = [];

function makeInvestigation(overrides: Partial<IncidentInvestigationViewDto> = {}): IncidentInvestigationViewDto {
  return {
    priority: makePriority(),
    signal: makeSignal(),
    relatedIncidents: [],
    affectedExecutions: [],
    affectedAgents: [],
    evidence: EMPTY_EVIDENCE_CHAIN,
    summary: {
      totalRelatedIncidents: 3,
      activeCount: 1,
      recoveredCount: 2,
      criticalCount: 0,
      highCount: 3,
      timeRange: {
        since: '2026-07-23T22:00:00.000Z',
        until: '2026-07-24T02:00:00.000Z',
      },
    },
    computedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

function makeHistory(overrides: Partial<IncidentHistoricalContextDto> = {}): IncidentHistoricalContextDto {
  return {
    incidentKey: 'exec-1|score-drop',
    kind: 'score-drop',
    executionId: 'exec-1',
    occurrenceCount: 4,
    recoveredCount: 3,
    averageDurationMs: 12_000,
    maxDurationMs: 60_000,
    firstSeen: '2026-07-20T00:00:00.000Z',
    lastSeen: '2026-07-24T00:00:00.000Z',
    recurrenceRate: 0.25,
    previousIncidents: [],
    hasHistory: true,
    computedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

function makeEvidenceItem(overrides: Partial<RootCauseEvidenceItemDto> = {}): RootCauseEvidenceItemDto {
  return {
    kind: 'history',
    message: 'recurring within 24h',
    confidence: 0.7,
    weight: 0.6,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<IncidentRootCauseEvidenceDto> = {}): IncidentRootCauseEvidenceDto {
  return {
    incidentKey: 'exec-1|score-drop',
    executionId: 'exec-1',
    kind: 'score-drop',
    evidence: [makeEvidenceItem()],
    confidence: 0.7,
    hasEvidence: true,
    computedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

function makeReport(overrides: Partial<IncidentInvestigationReportDto> = {}): IncidentInvestigationReportDto {
  return {
    incidentKey: 'exec-1|score-drop',
    investigation: makeInvestigation(),
    history: makeHistory(),
    evidence: makeEvidence(),
    generatedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

const ACTIONS: IncidentRecommendedActionBundleDto = {
  incidentKey: 'exec-1|score-drop',
  hasActions: true,
  actions: [
    { type: 'inspect-agent', priority: 'high', reason: 'score trending down' },
  ],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

const NARRATIVE: IncidentInvestigationNarrativeDto = {
  incidentKey: 'exec-1|score-drop',
  summary: 'Score dropped sharply',
  findings: ['finding 1'],
  hypotheses: ['hypothesis 1'],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

const TIMELINE: IncidentInvestigationTimelineDto = {
  incidentKey: 'exec-1|score-drop',
  events: [
    { timestamp: '2026-07-24T00:00:00.000Z', type: 'detected', message: 'detected' },
  ],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

// --- Tests -----------------------------------------------------------------

describe('useInvestigationWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.incidentReport.mockReset();
    mockedApi.incidentActions.mockReset();
    mockedApi.incidentNarrative.mockReset();
    mockedApi.incidentTimeline.mockReset();
  });

  it('initial state: every slot is { null, null }', () => {
    mockedApi.incidentReport.mockReturnValue(new Promise(() => {})); // never resolves
    mockedApi.incidentActions.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentNarrative.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentTimeline.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useInvestigationWorkspace('exec-1|score-drop'));
    expect(result.current).toEqual({
      report: null,
      reportErr: null,
      actions: null,
      actionsErr: null,
      narrative: null,
      narrativeErr: null,
      timeline: null,
      timelineErr: null,
    });
  });

  it('success: four endpoints fill their slots in parallel', async () => {
    const report = makeReport();
    mockedApi.incidentReport.mockResolvedValueOnce(report);
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce(TIMELINE);

    const { result } = renderHook(() => useInvestigationWorkspace('exec-1|score-drop'));

    await waitFor(() => {
      expect(result.current.report).toEqual(report);
      expect(result.current.actions).toEqual(ACTIONS);
      expect(result.current.narrative).toEqual(NARRATIVE);
      expect(result.current.timeline).toEqual(TIMELINE);
    });
    expect(result.current.reportErr).toBeNull();
    expect(result.current.actionsErr).toBeNull();
    expect(result.current.narrativeErr).toBeNull();
    expect(result.current.timelineErr).toBeNull();
  });

  it('error isolation: one failed endpoint does not affect the others', async () => {
    mockedApi.incidentReport.mockRejectedValueOnce(new Error('boom-report'));
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce(TIMELINE);

    const { result } = renderHook(() => useInvestigationWorkspace('exec-1|score-drop'));

    await waitFor(() => {
      expect(result.current.reportErr).toMatch(/boom-report/);
      expect(result.current.actions).toEqual(ACTIONS);
      expect(result.current.narrative).toEqual(NARRATIVE);
      expect(result.current.timeline).toEqual(TIMELINE);
    });
  });

  it('threads AbortSignal to all four endpoint wrappers', () => {
    mockedApi.incidentReport.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentActions.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentNarrative.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentTimeline.mockReturnValue(new Promise(() => {}));

    renderHook(() => useInvestigationWorkspace('exec-1|score-drop'));

    for (const fn of [
      mockedApi.incidentReport,
      mockedApi.incidentActions,
      mockedApi.incidentNarrative,
      mockedApi.incidentTimeline,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const [, signal] = fn.mock.calls[0]!;
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('incidentKey change: slots reset and the previous fetch is aborted (not surfaced)', async () => {
    // First key: timeline takes a long time, never resolves within test
    let rejectTimeline: (e: unknown) => void = () => {};
    const report = makeReport();
    mockedApi.incidentReport.mockResolvedValueOnce(report);
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockImplementationOnce(
      () =>
        new Promise<IncidentInvestigationTimelineDto>((_resolve, rej) => {
          rejectTimeline = rej;
        }),
    );

    const { result, rerender } = renderHook(
      ({ key }) => useInvestigationWorkspace(key),
      { initialProps: { key: 'exec-1|score-drop' } },
    );

    // Wait for the three fast endpoints to land; timeline is still pending.
    await waitFor(() => {
      expect(result.current.report).toEqual(report);
      expect(result.current.actions).toEqual(ACTIONS);
      expect(result.current.narrative).toEqual(NARRATIVE);
    });
    expect(result.current.timeline).toBeNull();

    // Re-render with a new incidentKey. The hook should reset state and
    // cancel the previous fetch (we simulate that by rejecting with an
    // AbortError — the hook must swallow it without setting timelineErr).
    mockedApi.incidentReport.mockResolvedValueOnce(report);
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce({
      ...TIMELINE,
      incidentKey: 'exec-2|score-drop',
    });

    await act(async () => {
      rerender({ key: 'exec-2|score-drop' });
    });

    // The previous timeline promise is now rejected as an AbortError
    // (the controller was aborted on cleanup).
    await act(async () => {
      rejectTimeline(new DOMException('aborted', 'AbortError'));
    });

    // After the rerender the new endpoints fill the slots.
    await waitFor(() => {
      expect(result.current.timeline?.incidentKey).toBe('exec-2|score-drop');
    });
    // The aborted previous fetch did NOT leak as a timelineErr.
    expect(result.current.timelineErr).toBeNull();
  });
});