/**
 * v1.13 Incident Historical Context — pure-function tests.
 *
 * Covers:
 *   - parseIncidentKey format validation
 *   - buildHistoricalContext: empty pool
 *   - buildHistoricalContext: single incident
 *   - buildHistoricalContext: repeated same-kind incidents across executions
 *   - buildHistoricalContext: recovered statistics (count + duration)
 *   - buildHistoricalContext: average / max duration calculation
 *   - buildHistoricalContext: firstSeen / lastSeen timestamps
 *   - buildHistoricalContext: recurrenceRate (escalationCount > 0 ratio)
 *   - buildHistoricalContext: previousIncidents excludes current + sorts DESC
 *   - buildHistoricalContext: deterministic (same input → same output)
 *   - buildHistoricalContext: invalid key → null
 *   - buildHistoricalContext: unknown current → null
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoricalContext,
  parseIncidentKey,
} from '../src/incident-history.js';
import type { HealthAnomalyKind, HealthIncident } from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);

/* ---------------- helpers ---------------- */

function mkInc(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  severity?: 'high' | 'critical';
  escalationCount?: number;
  lifecycle?: 'detected' | 'ongoing' | 'recovered';
  detectedAtMs: number;
  recoveredAtMs?: number | null;
}): HealthIncident {
  const kind = args.kind ?? 'score-drop';
  const lifecycle = args.lifecycle ?? 'recovered';
  const detectedAt = new Date(args.detectedAtMs).toISOString();
  const recoveredAt =
    args.recoveredAtMs !== undefined && args.recoveredAtMs !== null
      ? new Date(args.recoveredAtMs).toISOString()
      : null;
  const lastTransitionAt = recoveredAt ?? detectedAt;
  const durationMs =
    recoveredAt !== null ? Math.max(0, args.recoveredAtMs! - args.detectedAtMs) : null;
  return {
    incidentKey: `${args.executionId}|${kind}`,
    executionId: args.executionId,
    kind,
    severity: args.severity ?? 'high',
    initialSeverity: args.severity ?? 'high',
    currentSeverity: lifecycle === 'recovered' ? 'low' : (args.severity ?? 'high'),
    maxSeverity: args.severity ?? 'high',
    escalationCount: args.escalationCount ?? 0,
    detectedAt,
    lastTransitionAt,
    lifecycle,
    recoveredAt,
    durationMs,
    reason: `test ${kind} ${args.executionId}`,
  };
}

/* ---------------- parseIncidentKey ---------------- */

test('parseIncidentKey: valid score-drop', () => {
  const r = parseIncidentKey('exec-1|score-drop');
  assert.deepEqual(r, { executionId: 'exec-1', kind: 'score-drop' });
});

test('parseIncidentKey: valid level-regression with pipe in id', () => {
  // incidentKey uses lastIndexOf so the last `|` is the separator
  const r = parseIncidentKey('session:abc|exec-0|level-regression');
  assert.deepEqual(r, { executionId: 'session:abc|exec-0', kind: 'level-regression' });
});

test('parseIncidentKey: invalid kind', () => {
  assert.equal(parseIncidentKey('exec-1|not-a-kind'), null);
});

test('parseIncidentKey: missing separator', () => {
  assert.equal(parseIncidentKey('exec-1-score-drop'), null);
});

test('parseIncidentKey: empty executionId', () => {
  assert.equal(parseIncidentKey('|score-drop'), null);
});

test('parseIncidentKey: empty kind', () => {
  assert.equal(parseIncidentKey('exec-1|'), null);
});

/* ---------------- buildHistoricalContext: edge cases ---------------- */

test('buildHistoricalContext: invalid key returns null', () => {
  const r = buildHistoricalContext({
    incidentKey: 'exec-1|not-a-kind',
    allIncidents: [],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r, null);
});

test('buildHistoricalContext: current not in pool returns null', () => {
  const r = buildHistoricalContext({
    incidentKey: 'exec-1|score-drop',
    allIncidents: [
      mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 }),
    ],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r, null);
});

test('buildHistoricalContext: single incident — current is the only one', () => {
  const inc = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const r = buildHistoricalContext({
    incidentKey: inc.incidentKey,
    allIncidents: [inc],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.ok(r);
  assert.equal(r!.occurrenceCount, 1);
  assert.equal(r!.recoveredCount, 1);
  assert.equal(r!.previousIncidents.length, 0);
  assert.equal(r!.hasHistory, true);
  assert.equal(r!.recurrenceRate, 0);
  assert.equal(r!.averageDurationMs, 500);
  assert.equal(r!.maxDurationMs, 500);
});

/* ---------------- buildHistoricalContext: aggregation ---------------- */

test('buildHistoricalContext: aggregates same-kind across executions', () => {
  // Current incident on exec-1, plus 2 prior score-drop incidents on
  // different executions. Plus one level-regression (should NOT match).
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    recoveredAtMs: NOON + 1000,
  });
  const prior1 = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 60_000,
    recoveredAtMs: NOON - 50_000,
  });
  const prior2 = mkInc({
    executionId: 'exec-3',
    detectedAtMs: NOON - 30_000,
    severity: 'critical',
    escalationCount: 1,
    lifecycle: 'detected',
  });
  const otherKind = mkInc({
    executionId: 'exec-1',
    kind: 'level-regression',
    detectedAtMs: NOON - 20_000,
  });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current, prior1, prior2, otherKind],
    nowIso: new Date(NOON + 100).toISOString(),
  });
  assert.ok(r);
  assert.equal(r!.occurrenceCount, 3, 'kind scope matches 3 score-drop');
  assert.equal(r!.recoveredCount, 2, '2 of 3 are recovered');
  assert.equal(r!.kind, 'score-drop');
  assert.equal(r!.executionId, 'exec-1');
  assert.equal(r!.hasHistory, true);
  // previousIncidents = prior1 + prior2 sorted DESC by detectedAt
  assert.equal(r!.previousIncidents.length, 2);
  assert.equal(r!.previousIncidents[0]!.executionId, 'exec-3', 'newest first');
  assert.equal(r!.previousIncidents[1]!.executionId, 'exec-2');
  // average = (1000 + 10000) / 2 = 5500
  assert.equal(r!.averageDurationMs, 5500);
  assert.equal(r!.maxDurationMs, 10000);
  // recurrenceRate = 1 escalated / 3 matched = 0.333...
  assert.equal(Math.round(r!.recurrenceRate * 1000) / 1000, 0.333);
  // firstSeen = NOON - 60000 (prior1)
  assert.equal(r!.firstSeen, prior1.detectedAt);
  // lastSeen = current.recoveredAt (NOON + 1000) since it's the latest transition
  assert.equal(r!.lastSeen, current.recoveredAt);
});

test('buildHistoricalContext: recovered statistics', () => {
  const incidents = [
    mkInc({
      executionId: 'e1', detectedAtMs: NOON - 100_000,
      recoveredAtMs: NOON - 99_000, // 1000ms
    }),
    mkInc({
      executionId: 'e2', detectedAtMs: NOON - 50_000,
      recoveredAtMs: NOON - 47_000, // 3000ms
    }),
    mkInc({
      executionId: 'e3', detectedAtMs: NOON - 10_000,
      lifecycle: 'detected',
      // active — durationMs null
    }),
    mkInc({
      executionId: 'e1', // exec-1 with a level-regression (different kind, excluded)
      kind: 'level-regression',
      detectedAtMs: NOON - 5_000,
    }),
  ];
  const current = incidents[0]!;
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  assert.ok(r);
  assert.equal(r!.recoveredCount, 2);
  // avg = (1000 + 3000) / 2 = 2000
  assert.equal(r!.averageDurationMs, 2000);
  assert.equal(r!.maxDurationMs, 3000);
});

test('buildHistoricalContext: duration calculation — single recovered', () => {
  const inc = mkInc({
    executionId: 'e1',
    detectedAtMs: NOON,
    recoveredAtMs: NOON + 5000,
  });
  const r = buildHistoricalContext({
    incidentKey: inc.incidentKey,
    allIncidents: [inc],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.averageDurationMs, 5000);
  assert.equal(r!.maxDurationMs, 5000);
});

test('buildHistoricalContext: duration calculation — no recovered → null', () => {
  const current = mkInc({
    executionId: 'e1',
    detectedAtMs: NOON,
    // active, no durationMs
  });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.ok(r);
  assert.equal(r!.averageDurationMs, null);
  assert.equal(r!.maxDurationMs, null);
});

/* ---------------- buildHistoricalContext: recurrenceRate ---------------- */

test('buildHistoricalContext: recurrenceRate = 0 when no escalations', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON - 2000, recoveredAtMs: NOON - 1000 }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 1000, recoveredAtMs: NOON - 500 }),
    mkInc({ executionId: 'e3', detectedAtMs: NOON - 500, recoveredAtMs: NOON - 100 }),
  ];
  const r = buildHistoricalContext({
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.recurrenceRate, 0);
});

test('buildHistoricalContext: recurrenceRate = 1 when all escalated', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON, escalationCount: 1, severity: 'critical' }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 1000, escalationCount: 2, severity: 'critical' }),
  ];
  const r = buildHistoricalContext({
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.recurrenceRate, 1);
});

test('buildHistoricalContext: recurrenceRate partial (1 of 3)', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON - 3000 }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 2000, escalationCount: 1 }),
    mkInc({ executionId: 'e3', detectedAtMs: NOON - 1000 }),
  ];
  const r = buildHistoricalContext({
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  // 1 escalated of 3 matched = 0.333...
  assert.equal(Math.round(r!.recurrenceRate * 1000) / 1000, 0.333);
});

/* ---------------- buildHistoricalContext: firstSeen / lastSeen ---------------- */

test('buildHistoricalContext: firstSeen is earliest detectedAt', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON - 10_000 }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 60_000 }), // earliest
    mkInc({ executionId: 'e3', detectedAtMs: NOON - 30_000 }),
  ];
  const r = buildHistoricalContext({
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.firstSeen, incidents[1]!.detectedAt);
});

test('buildHistoricalContext: lastSeen is latest lastTransitionAt (or detectedAt)', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON - 30_000, recoveredAtMs: NOON - 20_000 }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 10_000 }), // active, lastTransition=detected
  ];
  const r = buildHistoricalContext({
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.lastSeen, incidents[1]!.detectedAt);
});

/* ---------------- buildHistoricalContext: previousIncidents ---------------- */

test('buildHistoricalContext: previousIncidents excludes current', () => {
  const current = mkInc({ executionId: 'e1', detectedAtMs: NOON });
  const prior = mkInc({ executionId: 'e2', detectedAtMs: NOON - 1000 });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current, prior],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.previousIncidents.length, 1);
  assert.equal(r!.previousIncidents[0]!.executionId, 'e2');
});

test('buildHistoricalContext: previousIncidents sorted DESC by detectedAt', () => {
  const current = mkInc({ executionId: 'e1', detectedAtMs: NOON });
  const prior1 = mkInc({ executionId: 'e2', detectedAtMs: NOON - 60_000 });
  const prior2 = mkInc({ executionId: 'e3', detectedAtMs: NOON - 30_000 });
  const prior3 = mkInc({ executionId: 'e4', detectedAtMs: NOON - 90_000 });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current, prior1, prior2, prior3],
    nowIso: new Date(NOON).toISOString(),
  });
  const keys = r!.previousIncidents.map((i) => i.executionId);
  assert.deepEqual(keys, ['e3', 'e2', 'e4']);
});

/* ---------------- buildHistoricalContext: deterministic ---------------- */

test('buildHistoricalContext: deterministic — same input yields same output', () => {
  const incidents = [
    mkInc({ executionId: 'e1', detectedAtMs: NOON, recoveredAtMs: NOON + 1000, escalationCount: 1 }),
    mkInc({ executionId: 'e2', detectedAtMs: NOON - 5000, recoveredAtMs: NOON - 4000 }),
    mkInc({ executionId: 'e3', detectedAtMs: NOON - 2000 }),
  ];
  const args = {
    incidentKey: incidents[0]!.incidentKey,
    allIncidents: incidents,
    nowIso: new Date(NOON + 100).toISOString(),
  };
  const a = buildHistoricalContext(args);
  const b = buildHistoricalContext(args);
  assert.deepEqual(a, b);
});

test('buildHistoricalContext: deterministic across reordered pool', () => {
  const a = mkInc({ executionId: 'e1', detectedAtMs: NOON - 1000 });
  const b = mkInc({ executionId: 'e2', detectedAtMs: NOON - 2000 });
  const c = mkInc({ executionId: 'e3', detectedAtMs: NOON - 3000 });
  const r1 = buildHistoricalContext({
    incidentKey: a.incidentKey,
    allIncidents: [a, b, c],
    nowIso: new Date(NOON).toISOString(),
  });
  const r2 = buildHistoricalContext({
    incidentKey: a.incidentKey,
    allIncidents: [c, a, b], // reordered
    nowIso: new Date(NOON).toISOString(),
  });
  // occurrenceCount, recoveredCount, firstSeen, lastSeen all stable
  assert.equal(r1!.occurrenceCount, r2!.occurrenceCount);
  assert.equal(r1!.recoveredCount, r2!.recoveredCount);
  assert.equal(r1!.firstSeen, r2!.firstSeen);
  assert.equal(r1!.lastSeen, r2!.lastSeen);
  // previousIncidents order is deterministic (DESC by detectedAt)
  assert.deepEqual(
    r1!.previousIncidents.map((i) => i.executionId),
    r2!.previousIncidents.map((i) => i.executionId),
  );
});

/* ---------------- buildHistoricalContext: scope ---------------- */

test('buildHistoricalContext: scope is same-kind, NOT same-execution', () => {
  // current is exec-1|score-drop. Same execution with a different kind
  // (level-regression) MUST NOT be in scope.
  const current = mkInc({ executionId: 'exec-1', kind: 'score-drop', detectedAtMs: NOON });
  const diffKindSameExec = mkInc({
    executionId: 'exec-1',
    kind: 'level-regression',
    detectedAtMs: NOON - 1000,
  });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current, diffKindSameExec],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.equal(r!.occurrenceCount, 1);
  assert.equal(r!.previousIncidents.length, 0);
});

test('buildHistoricalContext: rapid-degradation kind is supported', () => {
  const current = mkInc({
    executionId: 'e1',
    kind: 'rapid-degradation',
    detectedAtMs: NOON,
  });
  const r = buildHistoricalContext({
    incidentKey: current.incidentKey,
    allIncidents: [current],
    nowIso: new Date(NOON).toISOString(),
  });
  assert.ok(r);
  assert.equal(r!.kind, 'rapid-degradation');
});

/* ---------------- buildHistoricalContext: computedAt ---------------- */

test('buildHistoricalContext: computedAt is the caller-supplied timestamp', () => {
  const inc = mkInc({ executionId: 'e1', detectedAtMs: NOON });
  const r = buildHistoricalContext({
    incidentKey: inc.incidentKey,
    allIncidents: [inc],
    nowIso: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(r!.computedAt, '2026-07-23T00:00:00.000Z');
});