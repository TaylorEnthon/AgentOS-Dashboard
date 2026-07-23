/**
 * v1.15 Incident Investigation Report — pure-function tests.
 *
 * Covers:
 *   - buildInvestigationReport: returns null when any input is null
 *   - buildInvestigationReport: valid report passthrough
 *   - buildInvestigationReport: passthrough investigation (no mutation)
 *   - buildInvestigationReport: passthrough history (no mutation)
 *   - buildInvestigationReport: passthrough evidence (no mutation)
 *   - buildInvestigationReport: deterministic — same input yields same output
 *   - buildInvestigationReport: generatedAt is the caller-supplied timestamp
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestigationReport } from '../src/incident-report.js';
import type {
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentHistoricalContext,
  IncidentInvestigationView,
  IncidentPriorityInsight,
  IncidentRootCauseEvidence,
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

function mkInvestigationView(incidentKey: string, since: string, until: string): IncidentInvestigationView {
  const priority: IncidentPriorityInsight = {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 3,
    signalThreshold: 3,
    signalDescription: 'test',
    since,
    until,
    priorityScore: 80,
    priorityLevel: 'critical',
    reasons: [],
    trendHint: null,
  };
  return {
    priority,
    signal: {
      signalId: 'burst:score-drop',
      kind: 'burst',
      severity: 'alert',
      subjectKey: 'score-drop',
      since,
      until,
      score: 3,
      threshold: 3,
      description: 'test',
    },
    relatedIncidents: [mkInc({ executionId: 'exec-1', detectedAtMs: NOON })],
    affectedExecutions: [],
    affectedAgents: [],
    evidence: [],
    summary: {
      totalRelatedIncidents: 1,
      activeCount: 1,
      recoveredCount: 0,
      criticalCount: 1,
      highCount: 0,
      timeRange: { since, until },
    },
    computedAt: NOW_ISO,
  };
}

function mkHistory(incidentKey: string): IncidentHistoricalContext {
  return {
    incidentKey,
    kind: 'score-drop',
    executionId: 'exec-1',
    occurrenceCount: 1,
    recoveredCount: 0,
    averageDurationMs: null,
    maxDurationMs: null,
    firstSeen: NOW_ISO,
    lastSeen: NOW_ISO,
    recurrenceRate: 0,
    previousIncidents: [],
    hasHistory: true,
    computedAt: NOW_ISO,
  };
}

function mkEvidence(incidentKey: string): IncidentRootCauseEvidence {
  const item: RootCauseEvidenceItem = {
    kind: 'severity',
    message: 'Severity is high.',
    confidence: 1,
    weight: 0.7,
  };
  return {
    incidentKey,
    executionId: 'exec-1',
    kind: 'score-drop',
    evidence: [item],
    confidence: 1,
    hasEvidence: true,
    computedAt: NOW_ISO,
  };
}

/* ---------------- null inputs ---------------- */

test('buildInvestigationReport: returns null when investigation is null', () => {
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: null,
    history: mkHistory('exec-1|score-drop'),
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: NOW_ISO,
  });
  assert.equal(r, null);
});

test('buildInvestigationReport: returns null when history is null', () => {
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: null,
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: NOW_ISO,
  });
  assert.equal(r, null);
});

test('buildInvestigationReport: returns null when evidence is null', () => {
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: mkHistory('exec-1|score-drop'),
    evidence: null,
    nowIso: NOW_ISO,
  });
  assert.equal(r, null);
});

test('buildInvestigationReport: returns null when all three are null', () => {
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: null,
    history: null,
    evidence: null,
    nowIso: NOW_ISO,
  });
  assert.equal(r, null);
});

/* ---------------- valid ---------------- */

test('buildInvestigationReport: valid report — bundles all three views', () => {
  const inv = mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO);
  const hist = mkHistory('exec-1|score-drop');
  const ev = mkEvidence('exec-1|score-drop');
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: inv,
    history: hist,
    evidence: ev,
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.equal(r!.incidentKey, 'exec-1|score-drop');
  assert.equal(r!.investigation, inv);
  assert.equal(r!.history, hist);
  assert.equal(r!.evidence, ev);
  assert.equal(r!.generatedAt, NOW_ISO);
});

/* ---------------- passthrough ---------------- */

test('buildInvestigationReport: passthrough investigation (no mutation)', () => {
  const inv = mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO);
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: inv,
    history: mkHistory('exec-1|score-drop'),
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: NOW_ISO,
  });
  // The investigation object in the report is the SAME object (passthrough).
  assert.equal(r!.investigation, inv);
  // No new fields added.
  assert.deepEqual(Object.keys(r!.investigation).sort(), [
    'affectedAgents', 'affectedExecutions', 'computedAt', 'evidence',
    'priority', 'relatedIncidents', 'signal', 'summary',
  ]);
});

test('buildInvestigationReport: passthrough history (no mutation)', () => {
  const hist = mkHistory('exec-1|score-drop');
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: hist,
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.history, hist);
  assert.deepEqual(Object.keys(r!.history).sort(), [
    'averageDurationMs', 'computedAt', 'executionId', 'firstSeen',
    'hasHistory', 'incidentKey', 'kind', 'lastSeen',
    'maxDurationMs', 'occurrenceCount', 'previousIncidents',
    'recoveredCount', 'recurrenceRate',
  ]);
});

test('buildInvestigationReport: passthrough evidence (no mutation)', () => {
  const ev = mkEvidence('exec-1|score-drop');
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: mkHistory('exec-1|score-drop'),
    evidence: ev,
    nowIso: NOW_ISO,
  });
  assert.equal(r!.evidence, ev);
  assert.deepEqual(Object.keys(r!.evidence).sort(), [
    'computedAt', 'confidence', 'evidence', 'executionId',
    'hasEvidence', 'incidentKey', 'kind',
  ]);
});

/* ---------------- determinism ---------------- */

test('buildInvestigationReport: deterministic — same input yields same output', () => {
  const args = {
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: mkHistory('exec-1|score-drop'),
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: NOW_ISO,
  };
  const a = buildInvestigationReport(args);
  const b = buildInvestigationReport(args);
  assert.deepEqual(a, b);
});

test('buildInvestigationReport: generatedAt is the caller-supplied timestamp', () => {
  const r = buildInvestigationReport({
    incidentKey: 'exec-1|score-drop',
    investigation: mkInvestigationView('exec-1|score-drop', NOW_ISO, NOW_ISO),
    history: mkHistory('exec-1|score-drop'),
    evidence: mkEvidence('exec-1|score-drop'),
    nowIso: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(r!.generatedAt, '2030-01-01T00:00:00.000Z');
});

/* ---------------- bundling ---------------- */

test('buildInvestigationReport: bundling — incidentKey echoes', () => {
  const r = buildInvestigationReport({
    incidentKey: 'my-exec|level-regression',
    investigation: mkInvestigationView('my-exec|level-regression', NOW_ISO, NOW_ISO),
    history: mkHistory('my-exec|level-regression'),
    evidence: mkEvidence('my-exec|level-regression'),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.incidentKey, 'my-exec|level-regression');
});