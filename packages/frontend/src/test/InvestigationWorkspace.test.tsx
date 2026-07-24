/**
 * v1.20: InvestigationWorkspace component tests.
 *
 * Smoke + interaction tests for the workspace panel as a whole.
 *
 * Covers:
 *   - loading state (no data yet)
 *   - report-error fatal state
 *   - data-arrived rendering of all five sections
 *   - Summary is always visible (no collapse header); the four
 *     secondary sections are collapsed by default but can be expanded
 *   - per-section error display (one section failing does not blank
 *     the others)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { api } from '../lib/api';
import type {
  IncidentInvestigationReportDto,
  IncidentInvestigationNarrativeDto,
  IncidentInvestigationTimelineDto,
  IncidentRecommendedActionBundleDto,
} from '../lib/api';
import { InvestigationWorkspace } from '../pages/Workspace';

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

// Compact fixtures — only the fields the component actually reads
// are guaranteed; the rest is whatever shape the type allows.

const REPORT: IncidentInvestigationReportDto = {
  incidentKey: 'exec-1|score-drop',
  generatedAt: '2026-07-24T01:00:00.000Z',
  investigation: {
    priority: {
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
    },
    signal: {
      signalId: 'kind-surge:exec-1',
      kind: 'kind-surge',
      severity: 'warn',
      subjectKey: 'exec-1',
      since: '2026-07-23T22:00:00.000Z',
      until: '2026-07-24T02:00:00.000Z',
      score: 3,
      threshold: 2,
      description: 'kind-surge observed',
    },
    relatedIncidents: [],
    affectedExecutions: [],
    affectedAgents: [],
    evidence: [],
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
  },
  history: {
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
  },
  evidence: {
    incidentKey: 'exec-1|score-drop',
    executionId: 'exec-1',
    kind: 'score-drop',
    evidence: [
      { kind: 'history', message: 'recurring within 24h', confidence: 0.7, weight: 0.6 },
      { kind: 'severity', message: 'severity upgrade observed', confidence: 0.85, weight: 0.85 },
    ],
    confidence: 0.85,
    hasEvidence: true,
    computedAt: '2026-07-24T01:00:00.000Z',
  },
};

const ACTIONS: IncidentRecommendedActionBundleDto = {
  incidentKey: 'exec-1|score-drop',
  hasActions: true,
  actions: [
    { type: 'inspect-agent', priority: 'high', reason: 'score trending down' },
    { type: 'review-execution', priority: 'medium', reason: 'recent regression' },
  ],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

const NARRATIVE: IncidentInvestigationNarrativeDto = {
  incidentKey: 'exec-1|score-drop',
  summary: 'Score dropped sharply at T-2h.',
  findings: ['finding 1', 'finding 2'],
  hypotheses: ['hypothesis 1'],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

const TIMELINE: IncidentInvestigationTimelineDto = {
  incidentKey: 'exec-1|score-drop',
  events: [
    { timestamp: '2026-07-24T00:00:00.000Z', type: 'detected', message: 'detected msg' },
    { timestamp: '2026-07-24T00:30:00.000Z', type: 'escalated', message: 'escalated msg' },
  ],
  generatedAt: '2026-07-24T01:00:00.000Z',
};

const INCIDENT_KEY = 'exec-1|score-drop';

describe('InvestigationWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.incidentReport.mockReset();
    mockedApi.incidentActions.mockReset();
    mockedApi.incidentNarrative.mockReset();
    mockedApi.incidentTimeline.mockReset();
  });

  it('renders the loading state while report is pending', () => {
    mockedApi.incidentReport.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentActions.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentNarrative.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentTimeline.mockReturnValue(new Promise(() => {}));

    render(<InvestigationWorkspace incidentKey={INCIDENT_KEY} />);
    expect(screen.getByText(/loading workspace/i)).toBeInTheDocument();
  });

  it('shows the fatal error when report fails and no data is present', async () => {
    mockedApi.incidentReport.mockRejectedValueOnce(new Error('boom-report'));
    mockedApi.incidentActions.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentNarrative.mockReturnValue(new Promise(() => {}));
    mockedApi.incidentTimeline.mockReturnValue(new Promise(() => {}));

    render(<InvestigationWorkspace incidentKey={INCIDENT_KEY} />);
    await waitFor(() => {
      expect(screen.getByText(/report: .*boom-report/i)).toBeInTheDocument();
    });
  });

  it('renders Summary always-visible (no collapse header) and the four secondary sections collapsed by default', async () => {
    mockedApi.incidentReport.mockResolvedValueOnce(REPORT);
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce(TIMELINE);

    render(<InvestigationWorkspace incidentKey={INCIDENT_KEY} />);

    // Wait for data to land — Summary's priorityId is the most stable marker.
    await waitFor(() => {
      expect(screen.getByText(/score-drop:exec-1/i)).toBeInTheDocument();
    });

    // Summary is visible (no <button> wrapper for it).
    expect(screen.getByText(/^Summary$/)).toBeInTheDocument();

    // The four secondary section headers are buttons (CollapsibleSection).
    expect(screen.getByRole('button', { name: /Narrative/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Timeline/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Evidence/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Recommended actions/i })).toHaveAttribute('aria-expanded', 'false');

    // Section bodies are NOT rendered yet.
    expect(screen.queryByText(/Score dropped sharply at T-2h\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/detected msg/)).not.toBeInTheDocument();
    expect(screen.queryByText(/recurring within 24h/)).not.toBeInTheDocument();
    expect(screen.queryByText(/score trending down/)).not.toBeInTheDocument();
  });

  it('expands a secondary section on header click and renders its body', async () => {
    mockedApi.incidentReport.mockResolvedValueOnce(REPORT);
    mockedApi.incidentActions.mockResolvedValueOnce(ACTIONS);
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce(TIMELINE);

    render(<InvestigationWorkspace incidentKey={INCIDENT_KEY} />);
    await waitFor(() => {
      expect(screen.getByText(/score-drop:exec-1/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Narrative/i }));
    expect(screen.getByRole('button', { name: /Narrative/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Score dropped sharply at T-2h\./)).toBeInTheDocument();
    expect(screen.getByText(/finding 1/)).toBeInTheDocument();
  });

  it('shows section-level error when one endpoint fails, others still render', async () => {
    mockedApi.incidentReport.mockResolvedValueOnce(REPORT);
    mockedApi.incidentActions.mockRejectedValueOnce(new Error('boom-actions'));
    mockedApi.incidentNarrative.mockResolvedValueOnce(NARRATIVE);
    mockedApi.incidentTimeline.mockResolvedValueOnce(TIMELINE);

    render(<InvestigationWorkspace incidentKey={INCIDENT_KEY} />);

    // Wait for Summary to render (proves report landed).
    await waitFor(() => {
      expect(screen.getByText(/score-drop:exec-1/i)).toBeInTheDocument();
    });

    // Expand the actions section so its error body becomes visible.
    fireEvent.click(screen.getByRole('button', { name: /Recommended actions/i }));
    await waitFor(() => {
      expect(screen.getByText(/actions: .*boom-actions/i)).toBeInTheDocument();
    });
    // Summary still visible (other sections unaffected by error isolation).
    expect(screen.getByText(/score-drop:exec-1/i)).toBeInTheDocument();
  });
});