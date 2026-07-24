/**
 * v1.18 Incident Investigation Timeline — pure-function tests.
 *
 * Covers:
 *   - buildInvestigationTimeline: returns null when report is null
 *   - buildInvestigationTimeline: empty events when current not found in pool
 *   - buildInvestigationTimeline: 'detected' event always fires
 *   - buildInvestigationTimeline: 'escalated' event fires when escalationCount > 0
 *   - buildInvestigationTimeline: 'recovered' event fires when lifecycle === 'recovered'
 *   - buildInvestigationTimeline: 'recurred' event per previousIncident
 *   - buildInvestigationTimeline: events are ordered (timestamp ASC, type ASC)
 *   - buildInvestigationTimeline: deterministic — same input yields same output
 *   - buildInvestigationTimeline: generatedAt is the caller-supplied timestamp
 *   - buildInvestigationTimeline: incidentKey echoes
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestigationTimeline } from '../src/incident-timeline.js';
import type {
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentAgentRow,
  IncidentExecutionRow,
  IncidentHistoricalContext,
  IncidentInvestigationNarrative, // (used in helpers via shared types)
  IncidentInvestigationReport,
  IncidentInvestigationView,
  IncidentPriorityInsight,
  IntelligenceSignal,
} from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);
const NOW_ISO = new Date(NOON).toISOString();

/* ---------------- helpers ---------------- */

function mkInc(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  severity?: HealthAnomalySeverity;
  initialSeverity?: HealthAnomalySeverity;
  escalationCount?: number;
  lifecycle?: 'detected' | 'ongoing' | 'recovered';
  detectedAtMs: number;
  recoveredAtMs?: number | null;
  durationMs?: number | null;
}): HealthIncident {
  const kind = args.kind ?? 'score-drop';
  const severity = args.severity ?? 'high';
  const lifecycle = args.lifecycle ?? 'detected';
  const detectedAt = new Date(args.detectedAtMs).toISOString();
  const recoveredAt =
    args.recoveredAtMs !== undefined && args.recoveredAtMs !== null
      ? new Date(args.recoveredAtMs).toISOString()
      : null;
  const lastTransitionAt = recoveredAt ?? detectedAt;
  const durationMs =
    args.durationMs !== undefined
      ? args.durationMs
      : recoveredAt !== null
      ? Math.max(0, args.recoveredAtMs! - args.detectedAtMs)
      : null;
  return {
    incidentKey: `${args.executionId}|${kind}`,
    executionId: args.executionId,
    kind,
    severity,
    initialSeverity: args.initialSeverity ?? severity,
    currentSeverity: lifecycle === 'recovered' ? 'low' : severity,
    maxSeverity: severity,
    escalationCount: args.escalationCount ?? 0,
    detectedAt,
    lastTransitionAt,
    lifecycle,
    recoveredAt,
    durationMs,
    reason: `[${kind}]`,
  };
}

function mkPriority(): IncidentPriorityInsight {
  return {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 3,
    signalThreshold: 3,
    signalDescription: 'test',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 80,
    priorityLevel: 'critical',
    reasons: [],
    trendHint: null,
  };
}

function mkSignal(): IntelligenceSignal {
  return {
    signalId: 'burst:score-drop',
    kind: 'burst',
    severity: 'alert',
    subjectKey: 'score-drop',
    since: NOW_ISO,
    until: NOW_ISO,
    score: 3,
    threshold: 3,
    description: 'test',
  };
}

function mkInvestigation(args: {
  relatedIncidents?: HealthIncident[];
  affectedExecutions?: IncidentExecutionRow[];
  affectedAgents?: IncidentAgentRow[];
} = {}): IncidentInvestigationView {
  return {
    priority: mkPriority(),
    signal: mkSignal(),
    relatedIncidents: args.relatedIncidents ?? [],
    affectedExecutions: args.affectedExecutions ?? [],
    affectedAgents: args.affectedAgents ?? [],
    evidence: [],
    summary: {
      totalRelatedIncidents: args.relatedIncidents?.length ?? 0,
      activeCount: 0,
      recoveredCount: 0,
      criticalCount: 0,
      highCount: 0,
      timeRange: { since: NOW_ISO, until: NOW_ISO },
    },
    computedAt: NOW_ISO,
  };
}

function mkHistory(args: {
  occurrenceCount?: number;
  recoveredCount?: number;
  previousIncidents?: HealthIncident[];
  firstSeen?: string | null;
  lastSeen?: string | null;
  kind?: HealthAnomalyKind;
}): IncidentHistoricalContext {
  return {
    incidentKey: 'exec-1|score-drop',
    kind: args.kind ?? 'score-drop',
    executionId: 'exec-1',
    occurrenceCount: args.occurrenceCount ?? 1,
    recoveredCount: args.recoveredCount ?? 0,
    averageDurationMs: null,
    maxDurationMs: null,
    firstSeen: args.firstSeen === undefined ? NOW_ISO : args.firstSeen,
    lastSeen: args.lastSeen === undefined ? NOW_ISO : args.lastSeen,
    recurrenceRate: 0,
    previousIncidents: args.previousIncidents ?? [],
    hasHistory: true,
    computedAt: NOW_ISO,
  };
}

function mkReport(args: {
  investigation?: IncidentInvestigationView;
  history?: IncidentHistoricalContext;
  incidentKey?: string;
}): IncidentInvestigationReport {
  return {
    incidentKey: args.incidentKey ?? 'exec-1|score-drop',
    investigation: args.investigation ?? mkInvestigation(),
    history: args.history ?? mkHistory({}),
    evidence: {
      incidentKey: 'exec-1|score-drop',
      executionId: 'exec-1',
      kind: 'score-drop',
      evidence: [],
      confidence: 0,
      hasEvidence: false,
      computedAt: NOW_ISO,
    },
    generatedAt: NOW_ISO,
  };
}

/* ---------------- null report ---------------- */

test('buildInvestigationTimeline: returns null when report is null', () => {
  const r = buildInvestigationTimeline({ report: null, nowIso: NOW_ISO });
  assert.equal(r, null);
});

/* ---------------- empty events ---------------- */

test('buildInvestigationTimeline: empty events when current not in pool', () => {
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({
        relatedIncidents: [], // current is empty
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.equal(r!.events.length, 0);
  assert.equal(r!.hasEvents ?? r!.events.length > 0, false);
});

test('buildInvestigationTimeline: minimal report produces at least detected event', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.equal(r!.events.length, 1);
  assert.equal(r!.events[0]!.type, 'detected');
});

/* ---------------- detected event ---------------- */

test('buildInvestigationTimeline: detected event timestamp is current.detectedAt', () => {
  const detectedAtMs = NOON - 60_000;
  const current = mkInc({ executionId: 'exec-1', detectedAtMs });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.events[0]!.timestamp, new Date(detectedAtMs).toISOString());
  assert.match(r!.events[0]!.message, /score-drop incident detected on execution exec-1/);
});

/* ---------------- escalated event ---------------- */

test('buildInvestigationTimeline: escalated event fires when escalationCount > 0', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    escalationCount: 2,
    initialSeverity: 'high',
    severity: 'critical',
    lastTransitionAt: new Date(NOON + 60_000).toISOString(),
  });
  // Force lastTransitionAt
  current.lastTransitionAt = new Date(NOON + 60_000).toISOString();
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  const escalated = r!.events.find((e) => e.type === 'escalated');
  assert.ok(escalated);
  assert.match(escalated!.message, /Severity escalated to critical/);
  assert.match(escalated!.message, /2 escalation/);
});

test('buildInvestigationTimeline: escalated event does NOT fire when escalationCount = 0', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, escalationCount: 0 });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  const escalated = r!.events.find((e) => e.type === 'escalated');
  assert.equal(escalated, undefined);
});

/* ---------------- recovered event ---------------- */

test('buildInvestigationTimeline: recovered event fires when lifecycle === recovered', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    lifecycle: 'recovered',
    recoveredAtMs: NOON + 120_000,
    durationMs: 120_000,
  });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  const recovered = r!.events.find((e) => e.type === 'recovered');
  assert.ok(recovered);
  assert.equal(recovered!.timestamp, new Date(NOON + 120_000).toISOString());
  assert.match(recovered!.message, /Incident recovered after 2m/);
});

test('buildInvestigationTimeline: recovered event does NOT fire when not recovered', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, lifecycle: 'detected' });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  const recovered = r!.events.find((e) => e.type === 'recovered');
  assert.equal(recovered, undefined);
});

/* ---------------- recurred event ---------------- */

test('buildInvestigationTimeline: recurred event per prior occurrence', () => {
  const prior1 = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 3600_000 });
  const prior2 = mkInc({ executionId: 'exec-3', detectedAtMs: NOON - 7200_000 });
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({
        previousIncidents: [prior1, prior2],
        occurrenceCount: 3,
      }),
    }),
    nowIso: NOW_ISO,
  });
  const recurred = r!.events.filter((e) => e.type === 'recurred');
  assert.equal(recurred.length, 2);
});

test('buildInvestigationTimeline: recurred event timestamps sorted ASC', () => {
  // previousIncidents are typically sorted DESC (newest first). Timeline
  // should reverse to ASC order.
  const older = mkInc({ executionId: 'exec-3', detectedAtMs: NOON - 7200_000 });
  const newer = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 3600_000 });
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  // Pass them in DESC order (newer first) to verify sorting
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({ previousIncidents: [newer, older] }),
    }),
    nowIso: NOW_ISO,
  });
  const recurred = r!.events.filter((e) => e.type === 'recurred');
  assert.equal(recurred.length, 2);
  assert.ok(
    Date.parse(recurred[0]!.timestamp) <= Date.parse(recurred[1]!.timestamp),
    'recurred events should be sorted ASC by timestamp',
  );
});

test('buildInvestigationTimeline: no recurred events when no previousIncidents', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({ previousIncidents: [], occurrenceCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  const recurred = r!.events.filter((e) => e.type === 'recurred');
  assert.equal(recurred.length, 0);
});

/* ---------------- ordering ---------------- */

test('buildInvestigationTimeline: events are ordered (timestamp ASC, type ASC)', () => {
  // Use a recovered + escalated + recurred scenario to test ordering.
  const prior = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 3600_000 });
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    escalationCount: 1,
    lifecycle: 'recovered',
    recoveredAtMs: NOON + 120_000,
    durationMs: 120_000,
  });
  current.lastTransitionAt = new Date(NOON + 60_000).toISOString();
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({ previousIncidents: [prior], occurrenceCount: 2 }),
    }),
    nowIso: NOW_ISO,
  });
  // Expected order: detected (NOON) → recurred (NOON-3600s) wait that's earlier
  // Actually recurred is at NOON-3600s which is EARLIER than detected at NOON.
  // So order: recurred (NOON-3600s) → detected (NOON) → escalated (NOON+60s) → recovered (NOON+120s)
  const types = r!.events.map((e) => e.type);
  // Recurred should come first (earliest), then detected, then escalated, then recovered
  assert.equal(types[0], 'recurred');
  assert.equal(types[1], 'detected');
  assert.equal(types[2], 'escalated');
  assert.equal(types[3], 'recovered');
  // Verify timestamps are ASC
  for (let i = 1; i < r!.events.length; i++) {
    assert.ok(
      Date.parse(r!.events[i - 1]!.timestamp) <= Date.parse(r!.events[i]!.timestamp),
      `events should be ordered ASC at index ${i}`,
    );
  }
});

test('buildInvestigationTimeline: stable tie-break — same timestamp orders by type ASC', () => {
  // Force two events at the exact same timestamp.
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    escalationCount: 1,
  });
  // Make lastTransitionAt == detectedAt
  current.lastTransitionAt = current.detectedAt;
  const r = buildInvestigationTimeline({
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
    }),
    nowIso: NOW_ISO,
  });
  // detected should come before escalated (alphabetical: d < e)
  const types = r!.events.map((e) => e.type);
  assert.deepEqual(types, ['detected', 'escalated']);
});

/* ---------------- determinism ---------------- */

test('buildInvestigationTimeline: deterministic — same input yields same output', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, lifecycle: 'recovered', recoveredAtMs: NOON + 60_000 });
  const prior = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 3600_000 });
  const args = {
    report: mkReport({
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({ previousIncidents: [prior], occurrenceCount: 2 }),
    }),
    nowIso: NOW_ISO,
  };
  const a = buildInvestigationTimeline(args);
  const b = buildInvestigationTimeline(args);
  assert.deepEqual(a, b);
});

/* ---------------- generatedAt + incidentKey ---------------- */

test('buildInvestigationTimeline: generatedAt is the caller-supplied timestamp', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = buildInvestigationTimeline({
    report: mkReport({ investigation: mkInvestigation({ relatedIncidents: [current] }) }),
    nowIso: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(r!.generatedAt, '2030-01-01T00:00:00.000Z');
});

test('buildInvestigationTimeline: incidentKey echoes from report', () => {
  const r = buildInvestigationTimeline({
    report: mkReport({ incidentKey: 'my-exec|level-regression' }),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.incidentKey, 'my-exec|level-regression');
});

/* ---------------- cap ---------------- */

test('buildInvestigationTimeline: caps at MAX_TIMELINE_EVENTS (100)', () => {
  // Build 200 recurred events (more than the 100-event cap).
  const manyPriors: HealthIncident[] = [];
  for (let i = 0; i < 200; i++) {
    manyPriors.push(mkInc({
      executionId: `exec-old-${i}`,
      detectedAtMs: NOON - (i + 1) * 1000,
    }));
  }
  const current = mkInc({ executionId: 'exec-current', detectedAtMs: NOON });
  // v1.18 fix: incidentKey must match current.incidentKey so the function
  // can locate 'current' inside the investigation.relatedIncidents list.
  const r = buildInvestigationTimeline({
    report: mkReport({
      incidentKey: 'exec-current|score-drop',
      investigation: mkInvestigation({ relatedIncidents: [current] }),
      history: mkHistory({ previousIncidents: manyPriors, occurrenceCount: 201 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.events.length <= 100);
  assert.ok(r!.events.length >= 1); // at least 'detected'
});
