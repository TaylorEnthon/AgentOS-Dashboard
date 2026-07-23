/**
 * v1.8 Incident Severity Evolution tests.
 *
 * Covers:
 *  - initialSeverity / currentSeverity / maxSeverity / escalationCount
 *  - high → critical escalation is recorded
 *  - no automatic downgrade (severity only rises)
 *  - multiple escalations counted
 *  - rowsToIncidentDetail returns transitions + severityHistory
 *  - Severity upgrade detection in reconcileFromQueue
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import {
  _resetHealthHistoryDbForTests,
  attentionHistoryStore,
  setHealthHistoryDb,
} from '../src/health-history.js';
import {
  buildAllIncidentDetails,
  rowsToIncident,
  rowsToIncidentDetail,
} from '../src/incident-summary.js';
import type {
  AttentionHistoryEntry,
  AttentionLifecycleState,
  AttentionSeverity,
} from '@agentos/shared';

let counter = 0;
function entry(args: {
  executionId: string;
  lifecycle: AttentionLifecycleState;
  severity: AttentionSeverity;
  attentionKey?: string;
  reason?: string;
  createdAt?: string;
}): AttentionHistoryEntry {
  counter += 1;
  return {
    id: counter,
    executionId: args.executionId,
    attentionKey: args.attentionKey ?? 'investigate-anomaly-score-drop',
    lifecycle: args.lifecycle,
    severity: args.severity,
    reason: args.reason ?? `[score-drop] test reason ${counter}`,
    createdAt: args.createdAt ?? `2026-07-23T10:${String(counter % 60).padStart(2, '0')}:00.000Z`,
  };
}

/* ---------------- initialSeverity / currentSeverity / maxSeverity ---------------- */

test('severity: initial=high, current=high, max=high, escalationCount=0 (no escalation)', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high', createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low', createdAt: '2026-07-23T10:10:00.000Z' }),
  ];
  const inc = rowsToIncident(rows);
  assert.ok(inc);
  assert.equal(inc!.initialSeverity, 'high');
  assert.equal(inc!.currentSeverity, 'low'); // recovery row's severity is 'low'
  assert.equal(inc!.maxSeverity, 'high');
  assert.equal(inc!.severity, 'high'); // alias for maxSeverity
  assert.equal(inc!.escalationCount, 0);
});

test('severity: initial=high, max=critical after one escalation', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'high',   createdAt: '2026-07-23T10:05:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:10:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low',   createdAt: '2026-07-23T10:15:00.000Z' }),
  ];
  const inc = rowsToIncident(rows);
  assert.ok(inc);
  assert.equal(inc!.initialSeverity, 'high');
  assert.equal(inc!.maxSeverity, 'critical');
  assert.equal(inc!.currentSeverity, 'low'); // latest row is recovered
  assert.equal(inc!.escalationCount, 1);
});

test('severity: no automatic downgrade (high after critical stays high, never reverts)', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:05:00.000Z' }),
    // Hypothetical "downgrade" — should NOT be counted (no rule for downgrade)
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'high', createdAt: '2026-07-23T10:10:00.000Z' }),
  ];
  const inc = rowsToIncident(rows);
  assert.ok(inc);
  // maxSeverity stays critical (the worst ever observed)
  assert.equal(inc!.maxSeverity, 'critical');
  // currentSeverity reflects the latest row
  assert.equal(inc!.currentSeverity, 'high');
  // Only 1 escalation counted (high→critical); the hypothetical downgrade is ignored
  assert.equal(inc!.escalationCount, 1);
});

test('severity: multiple escalations (high→critical→high→critical = 2 escalations)', () => {
  // (We don't auto-downgrade, but if user manually re-detects after recovery
  //  we may see multiple escalation events.)
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:05:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low',   createdAt: '2026-07-23T10:10:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:15:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:20:00.000Z' }),
  ];
  const inc = rowsToIncident(rows);
  assert.ok(inc);
  assert.equal(inc!.escalationCount, 2);
  assert.equal(inc!.maxSeverity, 'critical');
});

/* ---------------- rowsToIncidentDetail transitions + severityHistory ---------------- */

test('detail: transitions contains every row in chronological order', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:05:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'recovered', severity: 'low',  createdAt: '2026-07-23T10:10:00.000Z' }),
  ];
  const detail = rowsToIncidentDetail(rows);
  assert.ok(detail);
  assert.equal(detail!.transitions.length, 3);
  assert.equal(detail!.transitions[0]!.lifecycle, 'detected');
  assert.equal(detail!.transitions[0]!.severity, 'high');
  assert.equal(detail!.transitions[1]!.lifecycle, 'ongoing');
  assert.equal(detail!.transitions[1]!.severity, 'critical');
  assert.equal(detail!.transitions[2]!.lifecycle, 'recovered');
  assert.equal(detail!.transitions[2]!.severity, 'low');
});

test('detail: severityHistory records each high→critical upgrade with timestamp + reason', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high',   createdAt: '2026-07-23T10:00:00.000Z' }),
    entry({ executionId: 'e1', lifecycle: 'ongoing',  severity: 'critical', createdAt: '2026-07-23T10:05:00.000Z' }),
  ];
  const detail = rowsToIncidentDetail(rows);
  assert.ok(detail);
  assert.equal(detail!.severityHistory.length, 1);
  assert.equal(detail!.severityHistory[0]!.from, 'high');
  assert.equal(detail!.severityHistory[0]!.to, 'critical');
  assert.equal(detail!.severityHistory[0]!.at, '2026-07-23T10:05:00.000Z');
  assert.ok(detail!.severityHistory[0]!.reason.length > 0);
});

test('detail: empty input returns null', () => {
  assert.equal(rowsToIncidentDetail([]), null);
});

test('detail: filters out non-anomaly attention keys', () => {
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
  assert.equal(rowsToIncidentDetail(rows), null);
});

test('detail: computedAt is set', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high' }),
  ];
  const detail = rowsToIncidentDetail(rows, { nowMs: 1_700_000_000_000 });
  assert.ok(detail);
  assert.equal(detail!.computedAt, new Date(1_700_000_000_000).toISOString());
});

/* ---------------- buildAllIncidentDetails (workspace convenience) ---------------- */

test('buildAllIncidentDetails: groups by (executionId, kind)', () => {
  const rows = [
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high', attentionKey: 'investigate-anomaly-score-drop' }),
    entry({ executionId: 'e1', lifecycle: 'detected', severity: 'high', attentionKey: 'investigate-anomaly-level-regression' }),
    entry({ executionId: 'e2', lifecycle: 'detected', severity: 'high', attentionKey: 'investigate-anomaly-score-drop' }),
  ];
  const all = buildAllIncidentDetails(rows);
  assert.equal(all.size, 3);
  assert.ok(all.get('e1|score-drop'));
  assert.ok(all.get('e1|level-regression'));
  assert.ok(all.get('e2|score-drop'));
});

/* ---------------- Live escalation detection via reconcileFromQueue ---------------- */

test('severity: live detection via reconcileFromQueue — high → critical escalates', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v18-sev-'));
  const db = new Db(path.join(tmpRoot, 'test.db'));
  setHealthHistoryDb(db);
  try {
    const events: Array<{ type: string; payload: unknown }> = [];
    const emit = (ev: unknown): void => {
      const e = ev as { type: string };
      events.push({ type: e.type, payload: ev });
    };
    // First pass: high severity
    attentionHistoryStore.reconcileAnomalies(
      [
        { executionId: 'e1', score: 95, level: 'healthy',  derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:00:00.000Z' },
        { executionId: 'e1', score: 50, level: 'warning',  derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:05:00.000Z' },
      ],
      '2026-07-23T10:05:00.000Z',
      { emit: emit as never },
    );
    // Second pass: critical severity (level regression)
    attentionHistoryStore.reconcileAnomalies(
      [
        { executionId: 'e1', score: 95, level: 'healthy',  derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:00:00.000Z' },
        { executionId: 'e1', score: 25, level: 'critical', derivedStatus: 'failed',  factors: [], createdAt: '2026-07-23T10:05:00.000Z' },
      ],
      '2026-07-23T10:10:00.000Z',
      { emit: emit as never },
    );
    const detected = events.filter((e) => e.type === 'incident_detected');
    const escalated = events.filter((e) => e.type === 'incident_escalated');
    // Both kinds (score-drop + level-regression) should have fired detected once
    assert.ok(detected.length >= 2, 'expected at least 2 incident_detected events');
    // At least one escalation event fired (high→critical)
    assert.ok(escalated.length >= 1, 'expected at least 1 incident_escalated event');
    const e = escalated[0]!.payload as { fromSeverity: string; toSeverity: string };
    assert.equal(e.fromSeverity, 'high');
    assert.equal(e.toSeverity, 'critical');
  } finally {
    _resetHealthHistoryDbForTests();
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('severity: live detection — recovery emits incident_recovered with durationMs', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v18-rec-'));
  const db = new Db(path.join(tmpRoot, 'test.db'));
  setHealthHistoryDb(db);
  try {
    const events: Array<{ type: string; payload: unknown }> = [];
    const emit = (ev: unknown): void => {
      const e = ev as { type: string };
      events.push({ type: e.type, payload: ev });
    };
    // First pass: detect
    attentionHistoryStore.reconcileAnomalies(
      [
        { executionId: 'e1', score: 95, level: 'healthy',  derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:00:00.000Z' },
        { executionId: 'e1', score: 30, level: 'critical', derivedStatus: 'failed',  factors: [], createdAt: '2026-07-23T10:05:00.000Z' },
      ],
      '2026-07-23T10:05:00.000Z',
      { emit: emit as never },
    );
    events.length = 0; // reset
    // Second pass: stable history → recovery
    attentionHistoryStore.reconcileAnomalies(
      [
        { executionId: 'e1', score: 90, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:10:00.000Z' },
        { executionId: 'e1', score: 88, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: '2026-07-23T10:15:00.000Z' },
      ],
      '2026-07-23T10:20:00.000Z', // 15 min after detection
      { emit: emit as never },
    );
    const recovered = events.filter((e) => e.type === 'incident_recovered');
    assert.ok(recovered.length >= 1, 'expected at least 1 incident_recovered event');
    const r = recovered[0]!.payload as { durationMs: number | null; incidentKey: string };
    assert.ok(r.durationMs !== null);
    assert.ok(r.durationMs! > 0, `durationMs should be > 0 (got ${r.durationMs})`);
  } finally {
    _resetHealthHistoryDbForTests();
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('severity: no emit for non-anomaly keys (conflict/blocked/etc.)', () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v18-noemit-'));
  const db = new Db(path.join(tmpRoot, 'test.db'));
  setHealthHistoryDb(db);
  try {
    const events: Array<{ type: string }> = [];
    const emit = (ev: unknown): void => {
      const e = ev as { type: string };
      events.push({ type: e.type });
    };
    // Manually craft a queue with a non-anomaly action
    attentionHistoryStore.reconcileFromQueue(
      [{
        executionId: 'e1', severity: 'critical', reason: 'manual conflict',
        recommendedAction: 'review-conflict', derivedStatus: 'running',
        detectedAt: '2026-07-23T10:00:00.000Z',
      }],
      '2026-07-23T10:00:00.000Z',
      { emit: emit as never },
    );
    // No incident_* events should fire
    assert.equal(events.filter((e) => e.type.startsWith('incident_')).length, 0);
  } finally {
    _resetHealthHistoryDbForTests();
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});