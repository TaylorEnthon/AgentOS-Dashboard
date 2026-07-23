/**
 * v1.6 Health Anomaly Detection tests.
 *
 * Covers:
 *  - detectHealthAnomalies: score-drop, level-regression, rapid-degradation
 *  - Pure-function invariants: deterministic, no DB, no I/O
 *  - Edge cases: empty history, single sample, stable history, mixed
 *  - Severity escalation rules (high vs critical)
 *  - anomaliesToAttentionItems shape (read-only bridge)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anomaliesToAttentionItems,
  detectHealthAnomalies,
} from '../src/health-anomaly.js';
import type {
  HealthAnomaly,
  HealthAnomalyKind,
  HealthLevel,
  HealthSnapshotHistory,
} from '@agentos/shared';

/* ---------------- helpers ---------------- */

let counter = 0;
function snap(args: {
  score: number;
  level: HealthLevel;
  derivedStatus?: HealthSnapshotHistory['derivedStatus'];
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
    derivedStatus: args.derivedStatus ?? 'running',
    factors: [],
    createdAt: ts,
  };
}

function findKind(arr: HealthAnomaly[], kind: HealthAnomalyKind): HealthAnomaly[] {
  return arr.filter((a) => a.kind === kind);
}

/* ---------------- 1. empty / single-sample ---------------- */

test('anomaly: empty history returns []', () => {
  assert.deepEqual(detectHealthAnomalies([]), []);
});

test('anomaly: single sample returns [] (no pairs to compare)', () => {
  const h = [snap({ score: 90, level: 'healthy' })];
  assert.deepEqual(detectHealthAnomalies(h), []);
});

/* ---------------- 2. stable case ---------------- */

test('anomaly: stable history returns []', () => {
  const h = [
    snap({ score: 80, level: 'healthy' }),
    snap({ score: 82, level: 'healthy' }),
    snap({ score: 78, level: 'healthy' }),
  ];
  assert.deepEqual(detectHealthAnomalies(h), []);
});

/* ---------------- 3. score drop ---------------- */

test('anomaly: score drop >= threshold fires score-drop', () => {
  const h = [
    snap({ score: 95, level: 'healthy' }),
    snap({ score: 25, level: 'critical' }),
  ];
  const out = detectHealthAnomalies(h);
  const drops = findKind(out, 'score-drop');
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.fromScore, 95);
  assert.equal(drops[0]!.toScore, 25);
  assert.equal(drops[0]!.severity, 'critical'); // 70 drop >= 30 * 2 = 60 multiplier
});

test('anomaly: small drop below threshold does NOT fire', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 75, level: 'warning' }),
  ];
  const drops = findKind(detectHealthAnomalies(h), 'score-drop');
  assert.equal(drops.length, 0);
});

test('anomaly: medium drop fires severity=high', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 55, level: 'warning' }),
  ];
  const drops = findKind(detectHealthAnomalies(h), 'score-drop');
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.severity, 'high'); // 35 < 30*2 = 60
});

test('anomaly: improving sequence has no score-drop', () => {
  const h = [
    snap({ score: 50, level: 'warning' }),
    snap({ score: 80, level: 'healthy' }),
    snap({ score: 95, level: 'healthy' }),
  ];
  assert.equal(findKind(detectHealthAnomalies(h), 'score-drop').length, 0);
});

/* ---------------- 4. level regression ---------------- */

test('anomaly: healthy→warning fires level-regression (severity=high)', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 80, level: 'warning' }),
  ];
  const out = detectHealthAnomalies(h);
  const reg = findKind(out, 'level-regression');
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.fromLevel, 'healthy');
  assert.equal(reg[0]!.toLevel, 'warning');
  assert.equal(reg[0]!.severity, 'high');
});

test('anomaly: healthy→critical fires level-regression (severity=critical)', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  const reg = findKind(detectHealthAnomalies(h), 'level-regression');
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.severity, 'critical');
});

test('anomaly: warning→critical fires level-regression (severity=critical)', () => {
  const h = [
    snap({ score: 60, level: 'warning' }),
    snap({ score: 35, level: 'critical' }),
  ];
  const reg = findKind(detectHealthAnomalies(h), 'level-regression');
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.severity, 'critical');
});

test('anomaly: same level does NOT fire regression', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 85, level: 'healthy' }),
  ];
  assert.equal(findKind(detectHealthAnomalies(h), 'level-regression').length, 0);
});

test('anomaly: improvement (critical→healthy) does NOT fire regression', () => {
  const h = [
    snap({ score: 30, level: 'critical' }),
    snap({ score: 80, level: 'healthy' }),
  ];
  assert.equal(findKind(detectHealthAnomalies(h), 'level-regression').length, 0);
});

/* ---------------- 5. rapid degradation ---------------- */

test('anomaly: 3-snapshot window with cumulative drop fires rapid-degradation', () => {
  const h = [
    snap({ score: 95, level: 'healthy' }),
    snap({ score: 80, level: 'healthy' }),
    snap({ score: 50, level: 'warning' }),
  ];
  const out = detectHealthAnomalies(h);
  const rapid = findKind(out, 'rapid-degradation');
  assert.equal(rapid.length, 1);
  assert.equal(rapid[0]!.fromScore, 95);
  assert.equal(rapid[0]!.toScore, 50);
  assert.equal(rapid[0]!.severity, 'high'); // 45 < 40*2 = 80
});

test('anomaly: small per-pair drops but big cumulative fires rapid-degradation', () => {
  // Each adjacent pair is < 30 points (below score-drop threshold of 30)
  // but the 3-window sums to 45 (above rapid threshold of 40).
  const h = [
    snap({ score: 95, level: 'healthy' }),
    snap({ score: 75, level: 'healthy' }),
    snap({ score: 50, level: 'warning' }),
  ];
  const out = detectHealthAnomalies(h);
  // No adjacent score-drop (drops are 20 and 25, both below 30)
  assert.equal(findKind(out, 'score-drop').length, 0);
  // But rapid-degradation fires (window drop = 95 - 50 = 45, above 40)
  const rapid = findKind(out, 'rapid-degradation');
  assert.equal(rapid.length, 1);
  assert.equal(rapid[0]!.fromScore, 95);
  assert.equal(rapid[0]!.toScore, 50);
});

test('anomaly: custom threshold honored', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 60, level: 'healthy' }),  // keep level same so only score-drop fires
  ];
  // With a high threshold, no score-drop anomaly
  const high = detectHealthAnomalies(h, { scoreDropThreshold: 50 });
  assert.equal(findKind(high, 'score-drop').length, 0);
  // With a low threshold, fires
  const low = detectHealthAnomalies(h, { scoreDropThreshold: 20 });
  assert.equal(findKind(low, 'score-drop').length, 1);
});

/* ---------------- 6. determinism ---------------- */

test('anomaly: deterministic — same input yields same output', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
    snap({ score: 20, level: 'critical' }),
  ];
  const a = detectHealthAnomalies(h);
  const b = detectHealthAnomalies(h);
  assert.deepEqual(a, b);
});

test('anomaly: deterministic — pure, no time-of-day side effects', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  // nowMs is irrelevant for detection (timestamps come from snapshots)
  const a = detectHealthAnomalies(h, { nowMs: 1 });
  const b = detectHealthAnomalies(h, { nowMs: 9_999_999_999 });
  assert.deepEqual(a, b);
});

/* ---------------- 7. mixed kinds ---------------- */

test('anomaly: a single transition can fire both score-drop AND level-regression', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  const out = detectHealthAnomalies(h);
  assert.equal(findKind(out, 'score-drop').length, 1);
  assert.equal(findKind(out, 'level-regression').length, 1);
});

test('anomaly: multiple transitions aggregate in chronological order', () => {
  const h = [
    snap({ score: 95, level: 'healthy' }),
    snap({ score: 60, level: 'warning' }),   // drop -35 (high)
    snap({ score: 25, level: 'critical' }),  // drop -35 + level-regression
  ];
  const out = detectHealthAnomalies(h);
  // 2 score-drops (i=1, i=2)
  assert.equal(findKind(out, 'score-drop').length, 2);
  // 2 level-regressions (warning then critical)
  assert.equal(findKind(out, 'level-regression').length, 2);
  // Rapid-degradation on the 3-window: 95 - 25 = 70 (>=40, but <80 → high)
  assert.equal(findKind(out, 'rapid-degradation').length, 1);
  // Order: chronological by detectedAt
  assert.equal(out[0]!.detectedAt <= out[1]!.detectedAt, true);
});

/* ---------------- 8. message / shape ---------------- */

test('anomaly: each anomaly has a non-empty message', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  const out = detectHealthAnomalies(h);
  for (const a of out) {
    assert.ok(typeof a.message === 'string' && a.message.length > 0, `empty message: ${JSON.stringify(a)}`);
    assert.equal(typeof a.executionId, 'string');
    assert.equal(typeof a.fromScore, 'number');
    assert.equal(typeof a.toScore, 'number');
    assert.equal(typeof a.detectedAt, 'string');
    assert.equal(typeof a.fromAt, 'string');
  }
});

test('anomaly: fromLevel is null only on first pair, otherwise populated', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  const out = detectHealthAnomalies(h);
  for (const a of out) {
    assert.notEqual(a.fromLevel, null);
    assert.equal(typeof a.toLevel, 'string');
  }
});

/* ---------------- 9. anomaliesToAttentionItems bridge ---------------- */

test('anomaly→attention: pure read-only bridge', () => {
  const h = [
    snap({ score: 90, level: 'healthy' }),
    snap({ score: 30, level: 'critical' }),
  ];
  const anomalies = detectHealthAnomalies(h);
  const items = anomaliesToAttentionItems(anomalies);
  assert.equal(items.length, anomalies.length);
  for (const it of items) {
    assert.ok(
      it.recommendedAction === 'investigate-anomaly' ||
      it.recommendedAction === 'investigate-anomaly-score-drop' ||
      it.recommendedAction === 'investigate-anomaly-level-regression' ||
      it.recommendedAction === 'investigate-anomaly-rapid-degradation',
      `unexpected action: ${it.recommendedAction}`,
    );
    assert.equal(it.derivedStatus, null);
    assert.ok(it.severity === 'high' || it.severity === 'critical');
    assert.ok(typeof it.reason === 'string' && it.reason.length > 0);
  }
});

test('anomaly→attention: empty input → empty output', () => {
  assert.deepEqual(anomaliesToAttentionItems([]), []);
});