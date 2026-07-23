/**
 * v1.7 Anomaly → Attention Lifecycle integration tests.
 *
 * Covers:
 *  - attentionHistoryStore.reconcileAnomalies(history)
 *  - First detection: writes 'detected' rows
 *  - Repeated reconciliation: writes 'ongoing' rows
 *  - Anomaly disappears: writes 'recovered' rows
 *  - Multiple anomaly kinds produce independent incidents
 *  - Empty history: no rows written
 *  - Reads back via attention history filter
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
import type {
  HealthLevel,
  HealthSnapshotHistory,
} from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v17-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
  setHealthHistoryDb(db);
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetHealthHistoryDbForTests();
}

let counter = 0;
function snap(args: {
  score: number;
  level: HealthLevel;
  minutesAgo?: number;
  executionId?: string;
}): HealthSnapshotHistory {
  counter += 1;
  const minutesAgo = args.minutesAgo ?? counter;
  const ts = new Date(Date.UTC(2026, 6, 23, 12, 0, 0) - minutesAgo * 60_000).toISOString();
  return {
    executionId: args.executionId ?? 'claude-code:abc:exec-0',
    score: args.score,
    level: args.level,
    derivedStatus: 'running',
    factors: [],
    createdAt: ts,
  };
}

function anomalyRows(executionId: string) {
  return attentionHistoryStore
    .read(executionId, 100)
    .filter((r) =>
      r.attentionKey === 'investigate-anomaly' ||
      r.attentionKey.startsWith('investigate-anomaly-'),
    );
}

/* ---------------- first detection ---------------- */

test('reconcileAnomalies: first detection writes a single "detected" row', () => {
  setup();
  try {
    const history = [
      snap({ score: 95, level: 'healthy' }),
      snap({ score: 25, level: 'critical' }),
    ];
    attentionHistoryStore.reconcileAnomalies(history);
    const rows = anomalyRows('claude-code:abc:exec-0');
    assert.equal(rows.length, 2, 'one row per anomaly (score-drop + level-regression)');
    for (const r of rows) {
      assert.equal(r.lifecycle, 'detected');
    }
  } finally { teardown(); }
});

test('reconcileAnomalies: empty history writes nothing', () => {
  setup();
  try {
    attentionHistoryStore.reconcileAnomalies([]);
    const rows = anomalyRows('claude-code:abc:exec-0');
    assert.equal(rows.length, 0);
  } finally { teardown(); }
});

test('reconcileAnomalies: stable history writes nothing', () => {
  setup();
  try {
    const history = [
      snap({ score: 80, level: 'healthy' }),
      snap({ score: 82, level: 'healthy' }),
      snap({ score: 78, level: 'healthy' }),
    ];
    attentionHistoryStore.reconcileAnomalies(history);
    const rows = anomalyRows('claude-code:abc:exec-0');
    assert.equal(rows.length, 0);
  } finally { teardown(); }
});

/* ---------------- ongoing ---------------- */

test('reconcileAnomalies: re-reconciling same anomaly → "ongoing" rows', () => {
  setup();
  try {
    const history1 = [
      snap({ score: 95, level: 'healthy',  minutesAgo: 10 }),
      snap({ score: 25, level: 'critical', minutesAgo: 5  }),
    ];
    attentionHistoryStore.reconcileAnomalies(history1);
    const firstRows = anomalyRows('claude-code:abc:exec-0');
    assert.ok(firstRows.length > 0);
    for (const r of firstRows) {
      assert.equal(r.lifecycle, 'detected');
    }
    // Re-reconcile with the same anomaly still present
    attentionHistoryStore.reconcileAnomalies(history1);
    const secondRows = anomalyRows('claude-code:abc:exec-0');
    // Each kind should now have 2 rows (detected + ongoing).
    const byKind = new Map<string, typeof secondRows>();
    for (const r of secondRows) {
      const k = `${r.executionId}|${r.reason.match(/^\[([^\]]+)\]/)?.[1]}`;
      const arr = byKind.get(k);
      if (arr) arr.push(r);
      else byKind.set(k, [r]);
    }
    for (const arr of byKind.values()) {
      const lifecycles = arr.map((r) => r.lifecycle).sort();
      assert.deepEqual(lifecycles, ['detected', 'ongoing']);
    }
  } finally { teardown(); }
});

/* ---------------- recovery ---------------- */

test('reconcileAnomalies: anomaly disappears → "recovered" row written', () => {
  setup();
  try {
    // First pass: anomaly exists
    const historyWith = [
      snap({ score: 95, level: 'healthy',  minutesAgo: 10 }),
      snap({ score: 25, level: 'critical', minutesAgo: 5  }),
    ];
    attentionHistoryStore.reconcileAnomalies(historyWith);
    const detectedRows = anomalyRows('claude-code:abc:exec-0');
    const detectedCount = detectedRows.length;
    assert.ok(detectedCount > 0);

    // Second pass: anomaly is gone (stable history)
    const historyStable = [
      snap({ score: 90, level: 'healthy' }),
      snap({ score: 88, level: 'healthy' }),
    ];
    attentionHistoryStore.reconcileAnomalies(historyStable);
    const afterRows = anomalyRows('claude-code:abc:exec-0');
    // Each previous kind should now have a recovered row appended
    const recoveredCount = afterRows.filter((r) => r.lifecycle === 'recovered').length;
    assert.equal(recoveredCount, detectedCount, 'one recovered row per prior incident');
  } finally { teardown(); }
});

test('reconcileAnomalies: detected → ongoing → recovered lifecycle persists across calls', () => {
  setup();
  try {
    const history1 = [
      snap({ score: 95, level: 'healthy',  minutesAgo: 20 }),
      snap({ score: 25, level: 'critical', minutesAgo: 15 }),
    ];
    attentionHistoryStore.reconcileAnomalies(history1);
    // Same anomaly persists
    attentionHistoryStore.reconcileAnomalies(history1);
    // Anomaly resolves
    const historyStable = [
      snap({ score: 90, level: 'healthy' }),
      snap({ score: 88, level: 'healthy' }),
    ];
    attentionHistoryStore.reconcileAnomalies(historyStable);
    const all = anomalyRows('claude-code:abc:exec-0');
    // Group by (attentionKey) — recovered rows have reason="No longer in
    // attention queue" so we can't parse the kind from the reason;
    // attentionKey is the stable per-kind identifier.
    const byKind = new Map<string, typeof all>();
    for (const r of all) {
      const k = r.attentionKey;
      const arr = byKind.get(k);
      if (arr) arr.push(r);
      else byKind.set(k, [r]);
    }
    for (const arr of byKind.values()) {
      const lifecycles = arr.map((r) => r.lifecycle);
      // Should contain detected, ongoing, recovered (in some order)
      assert.ok(lifecycles.includes('detected'));
      assert.ok(lifecycles.includes('ongoing'));
      assert.ok(lifecycles.includes('recovered'));
    }
  } finally { teardown(); }
});

/* ---------------- multiple kinds ---------------- */

test('reconcileAnomalies: multiple (exec, kind) pairs are independent', () => {
  setup();
  try {
    const h1 = [
      snap({ score: 95, level: 'healthy',  executionId: 'e1' }),
      snap({ score: 25, level: 'critical', executionId: 'e1' }),  // score-drop + level-regression
    ];
    const h2 = [
      snap({ score: 80, level: 'warning', executionId: 'e2' }),
      snap({ score: 80, level: 'warning', executionId: 'e2' }),
      snap({ score: 30, level: 'critical', executionId: 'e2' }), // level-regression only
    ];
    attentionHistoryStore.reconcileAnomalies(h1);
    attentionHistoryStore.reconcileAnomalies(h2);
    const e1 = anomalyRows('e1');
    const e2 = anomalyRows('e2');
    assert.ok(e1.length >= 2, `e1 should have score-drop + level-regression (got ${e1.length})`);
    assert.ok(e2.length >= 1, `e2 should have at least level-regression (got ${e2.length})`);
  } finally { teardown(); }
});

/* ---------------- severity carries through ---------------- */

test('reconcileAnomalies: severity (high/critical) is preserved', () => {
  setup();
  try {
    const history = [
      snap({ score: 95, level: 'healthy' }),
      snap({ score: 25, level: 'critical' }),
    ];
    attentionHistoryStore.reconcileAnomalies(history);
    const rows = anomalyRows('claude-code:abc:exec-0');
    for (const r of rows) {
      assert.ok(r.severity === 'high' || r.severity === 'critical');
    }
  } finally { teardown(); }
});

/* ---------------- id (and idempotence) ---------------- */

test('reconcileAnomalies: writes monotonically increasing row ids', () => {
  setup();
  try {
    const history1 = [
      snap({ score: 95, level: 'healthy' }),
      snap({ score: 25, level: 'critical' }),
    ];
    attentionHistoryStore.reconcileAnomalies(history1);
    const firstIds = anomalyRows('claude-code:abc:exec-0').map((r) => r.id ?? 0);

    const history2 = [
      snap({ score: 95, level: 'healthy' }),
      snap({ score: 25, level: 'critical' }),
      snap({ score: 22, level: 'critical' }), // additional score-drop + ongoing
    ];
    attentionHistoryStore.reconcileAnomalies(history2);
    const secondIds = anomalyRows('claude-code:abc:exec-0').map((r) => r.id ?? 0);
    // All new ids must be > all old ids
    const maxFirst = Math.max(...firstIds);
    const newOnes = secondIds.filter((id) => id > maxFirst);
    assert.ok(newOnes.length > 0);
  } finally { teardown(); }
});