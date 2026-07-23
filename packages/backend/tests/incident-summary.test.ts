/**
 * v1.7 Incident Summary pure-function tests.
 *
 * Covers:
 *  - extractKind parsing
 *  - rowsToIncident single (exec, kind) grouping
 *  - summarizeIncidents workspace rollup
 *  - Empty input
 *  - Mixed severity
 *  - Sorting (top affected by active count, recent recovered by recoveredAt desc)
 *  - Determinism
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKind,
  rowsToIncident,
  summarizeIncidents,
} from '../src/incident-summary.js';
import type {
  AttentionHistoryEntry,
  AttentionLifecycleState,
  AttentionSeverity,
  HealthAnomalyKind,
} from '@agentos/shared';

let counter = 0;
function entry(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  lifecycle: AttentionLifecycleState;
  severity?: AttentionSeverity;
  reason?: string;
  createdAt?: string;
}): AttentionHistoryEntry {
  counter += 1;
  const kind = args.kind ?? 'score-drop';
  const createdAt = args.createdAt ?? `2026-07-23T10:${String(counter % 60).padStart(2, '0')}:00.000Z`;
  return {
    id: counter,
    executionId: args.executionId,
    attentionKey: 'investigate-anomaly',
    lifecycle: args.lifecycle,
    severity: args.severity ?? 'high',
    reason: args.reason ?? `[${kind}] test reason`,
    createdAt,
  };
}

/* ---------------- extractKind ---------------- */

test('extractKind: parses [kind] prefix', () => {
  assert.equal(extractKind('[score-drop] foo'), 'score-drop');
  assert.equal(extractKind('[level-regression] foo'), 'level-regression');
  assert.equal(extractKind('[rapid-degradation] foo'), 'rapid-degradation');
});

test('extractKind: unknown prefix falls back to score-drop', () => {
  assert.equal(extractKind('plain text'), 'score-drop');
  assert.equal(extractKind('[unknown] foo'), 'score-drop');
  assert.equal(extractKind(''), 'score-drop');
});

/* ---------------- rowsToIncident ---------------- */

test('rowsToIncident: empty input → null', () => {
  assert.equal(rowsToIncident([]), null);
});

test('rowsToIncident: filters out non-anomaly attention keys', () => {
  const rows: AttentionHistoryEntry[] = [
    {
      id: 1,
      executionId: 'e1',
      attentionKey: 'review-conflict',
      lifecycle: 'detected',
      severity: 'critical',
      reason: 'manual vs derived',
      createdAt: '2026-07-23T10:00:00.000Z',
    },
  ];
  assert.equal(rowsToIncident(rows), null);
});

test('rowsToIncident: single detected row → incident in detected state', () => {
  const row = entry({ executionId: 'e1', lifecycle: 'detected', severity: 'critical' });
  const inc = rowsToIncident([row]);
  assert.ok(inc);
  assert.equal(inc!.executionId, 'e1');
  assert.equal(inc!.kind, 'score-drop');
  assert.equal(inc!.lifecycle, 'detected');
  assert.equal(inc!.severity, 'critical');
  assert.equal(inc!.recoveredAt, null);
  assert.equal(inc!.durationMs, null);
  assert.equal(inc!.incidentKey, 'e1|score-drop');
});

test('rowsToIncident: detected → ongoing → recovered', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected',  severity: 'high',     createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',   severity: 'high',     createdAt: '2026-07-23T10:05:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low',      createdAt: '2026-07-23T10:10:00.000Z' }),
  ];
  const inc = rowsToIncident(rows);
  assert.ok(inc);
  assert.equal(inc!.lifecycle, 'recovered');
  assert.equal(inc!.recoveredAt, '2026-07-23T10:10:00.000Z');
  assert.equal(inc!.durationMs, 10 * 60_000);
  // Severity stays "high" since the worst across the slice is "high"
  // (the "recovered" row is severity: low but we use max severity).
  assert.equal(inc!.severity, 'high');
});

test('rowsToIncident: critical row sets severity=critical even if mixed', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected',  severity: 'high' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',   severity: 'critical' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',   severity: 'high' }),
  ];
  const inc = rowsToIncident(rows);
  assert.equal(inc!.severity, 'critical');
  assert.equal(inc!.lifecycle, 'ongoing');
});

/* ---------------- summarizeIncidents ---------------- */

test('summarizeIncidents: empty → zero counts, empty arrays', () => {
  const s = summarizeIncidents([]);
  assert.equal(s.active, 0);
  assert.equal(s.recovered, 0);
  assert.equal(s.criticalCount, 0);
  assert.equal(s.highCount, 0);
  assert.equal(s.topAffected.length, 0);
  assert.equal(s.recentRecovered.length, 0);
  assert.equal(typeof s.computedAt, 'string');
});

test('summarizeIncidents: counts active vs recovered correctly', () => {
  const rows = [
    // e1: ongoing
    entry({ executionId: 'e1', lifecycle: 'detected',  severity: 'high' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',   severity: 'high' }),
    // e2: critical active
    entry({ executionId: 'e2', lifecycle: 'detected',  severity: 'critical' }),
    // e3: recovered
    entry({ executionId: 'e3', lifecycle: 'detected',  severity: 'high' }),
    entry({ executionId: 'e3', lifecycle: 'recovered', severity: 'low' }),
  ];
  const s = summarizeIncidents(rows);
  assert.equal(s.active, 2);     // e1, e2
  assert.equal(s.recovered, 1);  // e3
  assert.equal(s.criticalCount, 1);
  assert.equal(s.highCount, 2);
});

test('summarizeIncidents: topAffected sorted by activeCount desc', () => {
  const rows = [
    // e1: 1 active
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high' }),
    // e2: 3 active (3 different kinds)
    entry({ executionId: 'e2', lifecycle: 'detected', severity: 'high',     kind: 'score-drop' }),
    entry({ executionId: 'e2', lifecycle: 'detected', severity: 'high',     kind: 'level-regression' }),
    entry({ executionId: 'e2', lifecycle: 'detected', severity: 'critical', kind: 'rapid-degradation' }),
    // e3: recovered (should NOT appear in topAffected)
    entry({ executionId: 'e3', lifecycle: 'detected',  severity: 'high' }),
    entry({ executionId: 'e3', lifecycle: 'recovered', severity: 'low' }),
  ];
  const s = summarizeIncidents(rows);
  assert.equal(s.topAffected.length, 2);
  assert.equal(s.topAffected[0]!.executionId, 'e2');
  assert.equal(s.topAffected[0]!.activeCount, 3);
  assert.equal(s.topAffected[0]!.worstSeverity, 'critical');
  assert.equal(s.topAffected[1]!.executionId, 'e1');
  assert.equal(s.topAffected[1]!.activeCount, 1);
});

test('summarizeIncidents: topAffected capped at topAffectedLimit', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high' }),
    entry({ executionId: 'e2', lifecycle: 'detected', severity: 'high' }),
    entry({ executionId: 'e3', lifecycle: 'detected', severity: 'high' }),
    entry({ executionId: 'e4', lifecycle: 'detected', severity: 'high' }),
  ];
  const s = summarizeIncidents(rows, { topAffectedLimit: 2 });
  assert.equal(s.topAffected.length, 2);
});

test('summarizeIncidents: recentRecovered sorted newest first', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected',  severity: 'high', createdAt: '2026-07-23T08:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low',  createdAt: '2026-07-23T08:10:00.000Z' }),
    entry({ executionId: 'e2', lifecycle: 'detected',  severity: 'high', createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e2', lifecycle: 'recovered', severity: 'low',  createdAt: '2026-07-23T10:30:00.000Z' }),
  ];
  const s = summarizeIncidents(rows);
  assert.equal(s.recentRecovered.length, 2);
  // Newest recovered first
  assert.equal(s.recentRecovered[0]!.executionId, 'e2');
  assert.equal(s.recentRecovered[1]!.executionId, 'e1');
});

test('summarizeIncidents: deterministic — same input yields same output', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low' }),
  ];
  const a = summarizeIncidents(rows, { nowMs: 1 });
  const b = summarizeIncidents(rows, { nowMs: 9_999_999_999 });
  // computedAt will differ; everything else equal
  assert.equal(a.active, b.active);
  assert.equal(a.recovered, b.recovered);
  assert.deepEqual(a.topAffected, b.topAffected);
  assert.deepEqual(a.recentRecovered, b.recentRecovered);
});

test('summarizeIncidents: ignores non-anomaly attention entries', () => {
  const rows: AttentionHistoryEntry[] = [
    {
      id: 1,
      executionId: 'e1',
      attentionKey: 'review-conflict',
      lifecycle: 'detected',
      severity: 'critical',
      reason: 'manual vs derived',
      createdAt: '2026-07-23T10:00:00.000Z',
    },
    {
      id: 2,
      executionId: 'e1',
      attentionKey: 'restart-or-abandon',
      lifecycle: 'detected',
      severity: 'critical',
      reason: 'failed 30min ago',
      createdAt: '2026-07-23T10:00:00.000Z',
    },
  ];
  const s = summarizeIncidents(rows);
  assert.equal(s.active, 0);
  assert.equal(s.criticalCount, 0);
  assert.equal(s.topAffected.length, 0);
});