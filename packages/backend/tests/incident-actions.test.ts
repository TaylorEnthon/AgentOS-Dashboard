/**
 * v1.16 Incident Recommended Action — pure-function tests.
 *
 * Covers:
 *   - buildRecommendedActions: returns null when report is null
 *   - buildRecommendedActions: empty actions on a sparse report
 *   - buildRecommendedActions: 'inspect-agent' fires when agent evidence present + ≥ 2 agent incidents
 *   - buildRecommendedActions: 'inspect-agent' priority escalation
 *   - buildRecommendedActions: 'review-execution' fires when affectedExecutions > 1
 *   - buildRecommendedActions: 'compare-history' fires when occurrenceCount > 3
 *   - buildRecommendedActions: 'watch-recurrence' fires on incomplete recovery
 *   - buildRecommendedActions: 'watch-recurrence' fires on high recurrenceRate
 *   - buildRecommendedActions: stable ordering (priority DESC, type ASC)
 *   - buildRecommendedActions: deterministic — same input yields same output
 *   - buildRecommendedActions: generatedAt is the caller-supplied timestamp
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendedActions } from '../src/incident-actions.js';
import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentAgentRow,
  IncidentExecutionRow,
  IncidentHistoricalContext,
  IncidentInvestigationReport,
  IncidentInvestigationView,
  IncidentPriorityInsight,
  IncidentRootCauseEvidence,
  IntelligenceSignal,
  RootCauseEvidenceItem,
} from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);
const NOW_ISO = new Date(NOON).toISOString();

/* ---------------- helpers ---------------- */

function mkInc(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  severity?: HealthAnomalySeverity;
  detectedAtMs: number;
}): HealthIncident {
  const kind = args.kind ?? 'score-drop';
  return {
    incidentKey: `${args.executionId}|${kind}`,
    executionId: args.executionId,
    kind,
    severity: args.severity ?? 'high',
    initialSeverity: 'high',
    currentSeverity: 'high',
    maxSeverity: 'high',
    escalationCount: 0,
    detectedAt: new Date(args.detectedAtMs).toISOString(),
    lastTransitionAt: null,
    lifecycle: 'detected',
    recoveredAt: null,
    durationMs: null,
    reason: `[${kind}]`,
  };
}

function mkPriority(args: {
  score?: number;
  level?: 'critical' | 'high' | 'medium' | 'low';
  signalKind?: 'burst' | 'agent-degradation' | 'kind-surge' | 'recovery-surge';
  subjectKey?: string;
} = {}): IncidentPriorityInsight {
  return {
    priorityId: `${args.signalKind ?? 'burst'}:${args.subjectKey ?? 'score-drop'}`,
    signalKind: args.signalKind ?? 'burst',
    signalSeverity: 'alert',
    subjectKey: args.subjectKey ?? 'score-drop',
    signalId: `burst:${args.subjectKey ?? 'score-drop'}`,
    signalScore: 3,
    signalThreshold: 3,
    signalDescription: 'test',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: args.score ?? 80,
    priorityLevel: args.level ?? 'critical',
    reasons: [],
    trendHint: null,
  };
}

function mkSignal(subjectKey = 'score-drop'): IntelligenceSignal {
  return {
    signalId: `burst:${subjectKey}`,
    kind: 'burst',
    severity: 'alert',
    subjectKey,
    since: NOW_ISO,
    until: NOW_ISO,
    score: 3,
    threshold: 3,
    description: 'test',
  };
}

function mkInvestigation(args: {
  affectedExecutions?: IncidentExecutionRow[];
  affectedAgents?: IncidentAgentRow[];
  relatedIncidents?: HealthIncident[];
  priority?: IncidentPriorityInsight;
} = {}): IncidentInvestigationView {
  const priority = args.priority ?? mkPriority();
  return {
    priority,
    signal: mkSignal(priority.subjectKey),
    relatedIncidents: args.relatedIncidents ?? [
      mkInc({ executionId: 'exec-1', detectedAtMs: NOON }),
    ],
    affectedExecutions: args.affectedExecutions ?? [],
    affectedAgents: args.affectedAgents ?? [],
    evidence: [],
    summary: {
      totalRelatedIncidents: 1,
      activeCount: 1,
      recoveredCount: 0,
      criticalCount: 1,
      highCount: 0,
      timeRange: { since: NOW_ISO, until: NOW_ISO },
    },
    computedAt: NOW_ISO,
  };
}

function mkHistory(args: {
  occurrenceCount?: number;
  recoveredCount?: number;
  recurrenceRate?: number;
  kind?: HealthAnomalyKind;
  previousIncidents?: HealthIncident[];
} = {}): IncidentHistoricalContext {
  return {
    incidentKey: 'exec-1|score-drop',
    kind: args.kind ?? 'score-drop',
    executionId: 'exec-1',
    occurrenceCount: args.occurrenceCount ?? 1,
    recoveredCount: args.recoveredCount ?? 0,
    averageDurationMs: null,
    maxDurationMs: null,
    firstSeen: NOW_ISO,
    lastSeen: NOW_ISO,
    recurrenceRate: args.recurrenceRate ?? 0,
    previousIncidents: args.previousIncidents ?? [],
    hasHistory: true,
    computedAt: NOW_ISO,
  };
}

function mkEvidence(args: {
  evidence?: RootCauseEvidenceItem[];
  hasEvidence?: boolean;
} = {}): IncidentRootCauseEvidence {
  return {
    incidentKey: 'exec-1|score-drop',
    executionId: 'exec-1',
    kind: 'score-drop',
    evidence: args.evidence ?? [],
    confidence: 0,
    hasEvidence: args.hasEvidence ?? false,
    computedAt: NOW_ISO,
  };
}

function mkReport(args: {
  investigation?: IncidentInvestigationView;
  history?: IncidentHistoricalContext;
  evidence?: IncidentRootCauseEvidence;
  incidentKey?: string;
} = {}): IncidentInvestigationReport {
  return {
    incidentKey: args.incidentKey ?? 'exec-1|score-drop',
    investigation: args.investigation ?? mkInvestigation(),
    history: args.history ?? mkHistory(),
    evidence: args.evidence ?? mkEvidence(),
    generatedAt: NOW_ISO,
  };
}

function mkExecutionRow(args: {
  executionId: string;
  agentType: AgentType;
  incidentCount?: number;
  activeCount?: number;
}): IncidentExecutionRow {
  return {
    executionId: args.executionId,
    agentType: args.agentType,
    incidentCount: args.incidentCount ?? 1,
    activeCount: args.activeCount ?? 1,
    worstSeverity: 'high',
    lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
    lastIncidentAt: NOW_ISO,
  };
}

function mkAgentRow(args: {
  agentType: AgentType;
  executionCount?: number;
  incidentCount?: number;
  activeCount?: number;
  recoveredCount?: number;
  criticalCount?: number;
}): IncidentAgentRow {
  return {
    agentType: args.agentType,
    executionCount: args.executionCount ?? 1,
    incidentCount: args.incidentCount ?? 1,
    activeCount: args.activeCount ?? 1,
    recoveredCount: args.recoveredCount ?? 0,
    criticalCount: args.criticalCount ?? 0,
    worstSeverity: 'high',
    byKind: [{ kind: 'score-drop', incidentCount: args.incidentCount ?? 1 }],
  };
}

/* ---------------- null report ---------------- */

test('buildRecommendedActions: returns null when report is null', () => {
  const r = buildRecommendedActions({ report: null, nowIso: NOW_ISO });
  assert.equal(r, null);
});

/* ---------------- empty / sparse ---------------- */

test('buildRecommendedActions: empty bundle on a sparse report (single incident)', () => {
  const r = buildRecommendedActions({ report: mkReport(), nowIso: NOW_ISO });
  assert.ok(r);
  assert.equal(r!.actions.length, 0);
  assert.equal(r!.hasActions, false);
  assert.equal(r!.incidentKey, 'exec-1|score-drop');
});

test('buildRecommendedActions: single incident + high recurrence → only watch-recurrence', () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 1, recurrenceRate: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  // watch-recurrence requires ≥ 2 occurrences → not triggered.
  // Other rules also need ≥ 2 → not triggered.
  assert.equal(r!.actions.length, 0);
});

/* ---------------- inspect-agent ---------------- */

test("buildRecommendedActions: 'inspect-agent' fires when agent evidence + ≥ 2 agent incidents", () => {
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent',
    message: 'Agent "claude-code" has 3 score-drop incident(s) in this pool.',
    confidence: 0.75,
    weight: 0.85,
  };
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      investigation: mkInvestigation({
        affectedAgents: [
          mkAgentRow({ agentType: 'claude-code', incidentCount: 3, executionCount: 2 }),
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  const inspectAgent = r!.actions.find((a) => a.type === 'inspect-agent');
  assert.ok(inspectAgent);
  assert.equal(inspectAgent!.priority, 'medium'); // 3 < AGENT_INCIDENTS_HIGH (4)
  assert.match(inspectAgent!.reason, /claude-code/);
});

test("buildRecommendedActions: 'inspect-agent' priority = high when agent incidents ≥ 4", () => {
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent',
    message: 'Agent "claude-code" has 5 score-drop incident(s).',
    confidence: 0.85,
    weight: 0.85,
  };
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      investigation: mkInvestigation({
        affectedAgents: [
          mkAgentRow({ agentType: 'claude-code', incidentCount: 5 }),
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  const inspectAgent = r!.actions.find((a) => a.type === 'inspect-agent');
  assert.equal(inspectAgent!.priority, 'high');
});

test("buildRecommendedActions: 'inspect-agent' does NOT fire without agent evidence", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [], hasEvidence: false }),
      investigation: mkInvestigation({
        affectedAgents: [mkAgentRow({ agentType: 'claude-code', incidentCount: 5 })],
      }),
    }),
    nowIso: NOW_ISO,
  });
  const inspectAgent = r!.actions.find((a) => a.type === 'inspect-agent');
  assert.equal(inspectAgent, undefined);
});

test("buildRecommendedActions: 'inspect-agent' does NOT fire when agent has only 1 incident", () => {
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent',
    message: 'Agent "claude-code" has 1 score-drop incident(s).',
    confidence: 0.5,
    weight: 0.85,
  };
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      investigation: mkInvestigation({
        affectedAgents: [mkAgentRow({ agentType: 'claude-code', incidentCount: 1 })],
      }),
    }),
    nowIso: NOW_ISO,
  });
  const inspectAgent = r!.actions.find((a) => a.type === 'inspect-agent');
  assert.equal(inspectAgent, undefined);
});

/* ---------------- review-execution ---------------- */

test("buildRecommendedActions: 'review-execution' fires when affectedExecutions > 1", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      investigation: mkInvestigation({
        affectedExecutions: [
          mkExecutionRow({ executionId: 'e1', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e2', agentType: 'claude-code' }),
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  const review = r!.actions.find((a) => a.type === 'review-execution');
  assert.ok(review);
  assert.equal(review!.priority, 'medium');
  assert.match(review!.reason, /2 execution/);
});

test("buildRecommendedActions: 'review-execution' priority = high when > 3 executions", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      investigation: mkInvestigation({
        affectedExecutions: [
          mkExecutionRow({ executionId: 'e1', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e2', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e3', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e4', agentType: 'claude-code' }),
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  const review = r!.actions.find((a) => a.type === 'review-execution');
  assert.equal(review!.priority, 'high');
});

test("buildRecommendedActions: 'review-execution' does NOT fire with 1 execution", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      investigation: mkInvestigation({
        affectedExecutions: [mkExecutionRow({ executionId: 'e1', agentType: 'claude-code' })],
      }),
    }),
    nowIso: NOW_ISO,
  });
  const review = r!.actions.find((a) => a.type === 'review-execution');
  assert.equal(review, undefined);
});

/* ---------------- compare-history ---------------- */

test("buildRecommendedActions: 'compare-history' fires when occurrenceCount > 3", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 3 }),
    }),
    nowIso: NOW_ISO,
  });
  const compare = r!.actions.find((a) => a.type === 'compare-history');
  assert.ok(compare);
  assert.equal(compare!.priority, 'medium'); // 5 ≤ HISTORY_OCCURRENCES_HIGH (6)
  assert.match(compare!.reason, /5 times/);
});

test("buildRecommendedActions: 'compare-history' priority = high when > 6 occurrences", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 10, recoveredCount: 6 }),
    }),
    nowIso: NOW_ISO,
  });
  const compare = r!.actions.find((a) => a.type === 'compare-history');
  assert.equal(compare!.priority, 'high');
});

test("buildRecommendedActions: 'compare-history' does NOT fire with ≤ 3 occurrences", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 3 }),
    }),
    nowIso: NOW_ISO,
  });
  const compare = r!.actions.find((a) => a.type === 'compare-history');
  assert.equal(compare, undefined);
});

/* ---------------- watch-recurrence ---------------- */

test("buildRecommendedActions: 'watch-recurrence' fires on incomplete recovery", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  const watch = r!.actions.find((a) => a.type === 'watch-recurrence');
  assert.ok(watch);
  // recoveryRate = 1/5 = 0.2 < RECOVERY_RATE_HIGH (0.5) → high
  assert.equal(watch!.priority, 'high');
});

test("buildRecommendedActions: 'watch-recurrence' priority = medium on partial recovery", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 4, recoveredCount: 3 }),
    }),
    nowIso: NOW_ISO,
  });
  const watch = r!.actions.find((a) => a.type === 'watch-recurrence');
  // recoveryRate = 3/4 = 0.75 ≥ RECOVERY_RATE_HIGH (0.5) and < RECOVERY_RATE_MEDIUM (0.8) → medium
  assert.equal(watch!.priority, 'medium');
});

test("buildRecommendedActions: 'watch-recurrence' fires on high recurrenceRate", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({
        occurrenceCount: 4,
        recoveredCount: 4, // all recovered — incomplete=false
        recurrenceRate: 0.8,
      }),
    }),
    nowIso: NOW_ISO,
  });
  // All recovered but high recurrenceRate → still fires
  const watch = r!.actions.find((a) => a.type === 'watch-recurrence');
  assert.ok(watch);
  assert.match(watch!.reason, /recurrence rate/i);
});

test("buildRecommendedActions: 'watch-recurrence' does NOT fire with 1 occurrence", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  const watch = r!.actions.find((a) => a.type === 'watch-recurrence');
  assert.equal(watch, undefined);
});

test("buildRecommendedActions: 'watch-recurrence' does NOT fire when fully recovered and low recurrenceRate", () => {
  const r = buildRecommendedActions({
    report: mkReport({
      history: mkHistory({
        occurrenceCount: 4,
        recoveredCount: 4,
        recurrenceRate: 0,
      }),
    }),
    nowIso: NOW_ISO,
  });
  const watch = r!.actions.find((a) => a.type === 'watch-recurrence');
  assert.equal(watch, undefined);
});

/* ---------------- ordering ---------------- */

test('buildRecommendedActions: stable ordering — priority DESC, then type ASC', () => {
  // Force all 4 actions to fire.
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent', message: 'agent', confidence: 1, weight: 1,
  };
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      history: mkHistory({ occurrenceCount: 10, recoveredCount: 0, recurrenceRate: 0.9 }),
      investigation: mkInvestigation({
        affectedAgents: [mkAgentRow({ agentType: 'claude-code', incidentCount: 5 })],
        affectedExecutions: [
          mkExecutionRow({ executionId: 'e1', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e2', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e3', agentType: 'claude-code' }),
          mkExecutionRow({ executionId: 'e4', agentType: 'claude-code' }),
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.equal(r!.actions.length, 4);
  // All high priority — sort by type ASC.
  const types = r!.actions.map((a) => a.type);
  assert.deepEqual(types, [
    'compare-history', // C
    'inspect-agent',   // I
    'review-execution',// R
    'watch-recurrence',// W
  ]);
});

test('buildRecommendedActions: high actions come before medium actions', () => {
  // Force one high and one medium action.
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent', message: 'agent', confidence: 1, weight: 1,
  };
  const r = buildRecommendedActions({
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      history: mkHistory({ occurrenceCount: 4, recoveredCount: 4, recurrenceRate: 0 }), // compare-history medium (no watch-recurrence — fully recovered)
      investigation: mkInvestigation({
        affectedAgents: [mkAgentRow({ agentType: 'claude-code', incidentCount: 5 })], // inspect-agent high
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.equal(r!.actions.length, 2);
  // inspect-agent (high) should come first
  assert.equal(r!.actions[0]!.type, 'inspect-agent');
  assert.equal(r!.actions[1]!.type, 'compare-history');
});

/* ---------------- determinism ---------------- */

test('buildRecommendedActions: deterministic — same input yields same output', () => {
  const agentEvidence: RootCauseEvidenceItem = {
    kind: 'agent', message: 'agent', confidence: 1, weight: 1,
  };
  const args = {
    report: mkReport({
      evidence: mkEvidence({ evidence: [agentEvidence], hasEvidence: true }),
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 2 }),
      investigation: mkInvestigation({
        affectedAgents: [mkAgentRow({ agentType: 'claude-code', incidentCount: 3 })],
      }),
    }),
    nowIso: NOW_ISO,
  };
  const a = buildRecommendedActions(args);
  const b = buildRecommendedActions(args);
  assert.deepEqual(a, b);
});

/* ---------------- generatedAt ---------------- */

test('buildRecommendedActions: generatedAt is the caller-supplied timestamp', () => {
  const r = buildRecommendedActions({
    report: mkReport(),
    nowIso: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(r!.generatedAt, '2030-01-01T00:00:00.000Z');
});

/* ---------------- incidentKey echo ---------------- */

test('buildRecommendedActions: incidentKey echoes from report', () => {
  const r = buildRecommendedActions({
    report: mkReport({ incidentKey: 'my-exec|level-regression' }),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.incidentKey, 'my-exec|level-regression');
});