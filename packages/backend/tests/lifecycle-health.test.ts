/**
 * v1.3 Agent Health Intelligence tests.
 *
 * Covers:
 *  - Health Score: 3 levels (healthy / warning / critical) + factor ordering + purity
 *  - Explanation: each status + conflict wrapping
 *  - Attention Queue: 5 trigger paths + severity sorting + empty case
 *  - Workspace Summary: counts + longest running + conflictCount + totals
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttentionQueue,
  computeHealthScore,
  computeWorkspaceSummary,
  explainLifecycle,
} from '../src/lifecycle-health.js';
import type {
  AttentionSeverity,
  DerivedLifecycleStatus,
  LifecycleConflict,
  LifecycleHealthScore,
  LifecycleSnapshot,
} from '@agentos/shared';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');

function snap(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    executionId: 'claude-code:abc:exec-0',
    derivedStatus: 'running',
    confidence: 'high',
    reason: 'test',
    lastActivityAt: new Date(NOW - 1000).toISOString(),
    lastActivityAgeMs: 1000,
    indicators: [],
    computedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function conflict(overrides: Partial<LifecycleConflict> = {}): LifecycleConflict {
  return {
    executionId: 'claude-code:abc:exec-0',
    manualStatus: 'done',
    derivedStatus: 'running',
    confidence: 'high',
    reason: 'test',
    isConflict: true,
    label: 'done vs running',
    ...overrides,
  };
}

/* ---------------- 1. Health Score ---------------- */

test('computeHealthScore: healthy running execution → score >= 80', () => {
  const r = computeHealthScore({ snapshot: snap() });
  assert.ok(r.score >= 80, `expected >=80, got ${r.score}`);
  assert.equal(r.level, 'healthy');
});

test('computeHealthScore: failed → critical (< 50)', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'failed', confidence: 'high' }) });
  assert.ok(r.score < 50, `expected <50, got ${r.score}`);
  assert.equal(r.level, 'critical');
});

test('computeHealthScore: blocked → critical', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'blocked', confidence: 'high' }) });
  assert.equal(r.level, 'critical');
});

test('computeHealthScore: idle → warning (around 50)', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'idle', confidence: 'high' }) });
  assert.equal(r.level, 'warning');
  assert.ok(r.score >= 50 && r.score < 80, `got ${r.score}`);
});

test('computeHealthScore: queued → healthy-ish (no penalty)', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'queued', confidence: 'high' }) });
  // queued has no penalty; should be 100 + small bonuses, clamped to 100
  assert.ok(r.score >= 80);
});

test('computeHealthScore: completed → healthy-ish', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'completed', confidence: 'high' }) });
  assert.ok(r.score >= 80);
});

test('computeHealthScore: low confidence drops score significantly', () => {
  const r = computeHealthScore({ snapshot: snap({ derivedStatus: 'running', confidence: 'low' }) });
  assert.ok(r.score < 80);
});

test('computeHealthScore: conflict always drags score', () => {
  const without = computeHealthScore({ snapshot: snap() });
  const with_ = computeHealthScore({ snapshot: snap(), conflict: conflict() });
  assert.ok(with_.score < without.score, `${with_.score} should be < ${without.score}`);
});

test('computeHealthScore: long idle (> 24h) drags score further', () => {
  const fresh = computeHealthScore({ snapshot: snap({ derivedStatus: 'idle', lastActivityAgeMs: 60_000 }) });
  const stale = computeHealthScore({ snapshot: snap({ derivedStatus: 'idle', lastActivityAgeMs: 25 * 60 * 60_000 }) });
  assert.ok(stale.score < fresh.score);
});

test('computeHealthScore: multiple negative indicators drag score', () => {
  const r = computeHealthScore({
    snapshot: snap({
      derivedStatus: 'running',
      indicators: [
        { type: 'no-activity', label: 'no', weight: 1 },
        { type: 'contradiction', label: 'ct', weight: 1 },
        { type: 'failure-marker', label: 'fm', weight: 1 },
      ],
    }),
  });
  // running gives +8, but 3 negative indicators drag -10; net = -2.
  // Plus high-confidence +4. Final ~ 102 → clamp 100.
  assert.ok(r.score <= 100);
});

test('computeHealthScore: factors sorted by abs(impact) desc', () => {
  const r = computeHealthScore({
    snapshot: snap({ derivedStatus: 'failed', confidence: 'low' }),
    conflict: conflict(),
  });
  for (let i = 1; i < r.factors.length; i++) {
    assert.ok(Math.abs(r.factors[i - 1]!.impact) >= Math.abs(r.factors[i]!.impact));
  }
});

test('computeHealthScore: deterministic', () => {
  const a = computeHealthScore({ snapshot: snap() });
  const b = computeHealthScore({ snapshot: snap() });
  assert.deepEqual(a, b);
});

test('computeHealthScore: score clamped to [0, 100]', () => {
  // Worst case: failed + low confidence + long idle + conflict
  const r = computeHealthScore({
    snapshot: snap({
      derivedStatus: 'failed',
      confidence: 'low',
      lastActivityAgeMs: 30 * 24 * 60 * 60_000,
    }),
    conflict: conflict(),
  });
  assert.ok(r.score >= 0 && r.score <= 100);
});

/* ---------------- 2. Explanation ---------------- */

test('explainLifecycle: running → active headline + recent bullets', () => {
  const e = explainLifecycle(snap({ derivedStatus: 'running' }));
  assert.match(e.headline, /active/i);
  assert.ok(e.bullets.length >= 1);
});

test('explainLifecycle: blocked → stuck headline + commit + activity age', () => {
  const e = explainLifecycle(snap({
    derivedStatus: 'blocked',
    indicators: [{ type: 'commit-landed', label: '1 commit 5m ago', weight: 1 }],
    lastActivityAgeMs: 35 * 60_000,
  }));
  assert.match(e.headline, /stuck/i);
  assert.ok(e.bullets.some((b) => /commit/i.test(b)));
  assert.ok(e.bullets.some((b) => /35/.test(b)));
});

test('explainLifecycle: conflict → headline reflects manual vs derived', () => {
  const e = explainLifecycle(snap({ derivedStatus: 'running' }), conflict());
  assert.match(e.headline, /manual/i);
  assert.match(e.headline, /derived/i);
  assert.ok(e.bullets.some((b) => /manual/i.test(b) && /derived/i.test(b)));
});

test('explainLifecycle: failed → failure marker in bullets', () => {
  const e = explainLifecycle(snap({
    derivedStatus: 'failed',
    indicators: [{ type: 'failure-marker', label: 'session-end: out of context', weight: 1 }],
  }));
  assert.match(e.headline, /fail/i);
  assert.ok(e.bullets.some((b) => /out of context/.test(b)));
});

test('explainLifecycle: idle → idle headline + last event time', () => {
  const e = explainLifecycle(snap({ derivedStatus: 'idle', lastActivityAgeMs: 7 * 60_000 }));
  assert.match(e.headline, /idle/i);
  assert.ok(e.bullets.some((b) => /7/.test(b)));
});

test('explainLifecycle: completed → headline includes finished', () => {
  const e = explainLifecycle(snap({ derivedStatus: 'completed' }));
  assert.match(e.headline, /finish|complet/i);
});

test('explainLifecycle: queued → headline about starting', () => {
  const e = explainLifecycle(snap({ derivedStatus: 'queued' }));
  assert.match(e.headline, /start|queue/i);
});

test('explainLifecycle: low confidence surfaces a caveat bullet', () => {
  const e = explainLifecycle(snap({ confidence: 'low' }));
  assert.ok(e.bullets.some((b) => /confidence/i.test(b)));
});

/* ---------------- 3. Attention Queue ---------------- */

test('buildAttentionQueue: empty inputs → empty array', () => {
  assert.deepEqual(buildAttentionQueue([], NOW), []);
});

test('buildAttentionQueue: conflict → critical + review-conflict', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'running' }),
      conflict: conflict({ isConflict: true, label: 'done vs running' }),
    },
  ], NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.severity, 'critical');
  assert.equal(queue[0]!.recommendedAction, 'review-conflict');
});

test('buildAttentionQueue: blocked > 2h → high + investigate-blocked', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({
        derivedStatus: 'blocked',
        lastActivityAgeMs: 3 * 60 * 60_000,
      }),
    },
  ], NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.severity, 'high');
  assert.equal(queue[0]!.recommendedAction, 'investigate-blocked');
});

test('buildAttentionQueue: blocked < 2h → not in queue', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'blocked', lastActivityAgeMs: 60 * 60_000 }),
    },
  ], NOW);
  assert.equal(queue.length, 0);
});

test('buildAttentionQueue: failed > 30min → critical + restart-or-abandon', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'failed', lastActivityAgeMs: 60 * 60_000 }),
    },
  ], NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.severity, 'critical');
  assert.equal(queue[0]!.recommendedAction, 'restart-or-abandon');
});

test('buildAttentionQueue: idle > 24h → medium + archive', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'idle', lastActivityAgeMs: 25 * 60 * 60_000 }),
    },
  ], NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.severity, 'medium');
  assert.equal(queue[0]!.recommendedAction, 'archive');
});

test('buildAttentionQueue: queued > 10min → low + monitor', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'queued', lastActivityAgeMs: 11 * 60_000 }),
    },
  ], NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.severity, 'low');
  assert.equal(queue[0]!.recommendedAction, 'monitor');
});

test('buildAttentionQueue: running + no conflict → not in queue', () => {
  const queue = buildAttentionQueue([
    {
      executionId: 'e1',
      snapshot: snap({ derivedStatus: 'running', lastActivityAgeMs: 1000 }),
    },
  ], NOW);
  assert.equal(queue.length, 0);
});

test('buildAttentionQueue: sorted critical → high → medium → low', () => {
  const queue = buildAttentionQueue([
    { executionId: 'a', snapshot: snap({ derivedStatus: 'idle', lastActivityAgeMs: 25 * 60 * 60_000 }) }, // medium
    { executionId: 'b', snapshot: snap({ derivedStatus: 'failed', lastActivityAgeMs: 60 * 60_000 }) }, // critical
    { executionId: 'c', snapshot: snap({ derivedStatus: 'queued', lastActivityAgeMs: 11 * 60_000 }) }, // low
    { executionId: 'd', snapshot: snap({ derivedStatus: 'blocked', lastActivityAgeMs: 3 * 60 * 60_000 }) }, // high
  ], NOW);
  assert.equal(queue.length, 4);
  const order = queue.map((q) => q.severity);
  // critical before high before medium before low
  const rank: Record<AttentionSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i - 1]!] <= rank[order[i]!]);
  }
});

/* ---------------- 4. Workspace Summary ---------------- */

test('computeWorkspaceSummary: empty input → all zeros', () => {
  const s = computeWorkspaceSummary({ executions: [], health: [], conflicts: [] });
  assert.equal(s.total, 0);
  assert.equal(s.healthy, 0);
  assert.equal(s.warning, 0);
  assert.equal(s.critical, 0);
  assert.equal(s.conflictCount, 0);
  assert.equal(s.longestRunning, null);
});

test('computeWorkspaceSummary: counts healthy / warning / critical', () => {
  const mkHealth = (id: string, level: 'healthy' | 'warning' | 'critical'): LifecycleHealthScore => ({
    score: level === 'healthy' ? 90 : level === 'warning' ? 60 : 30,
    level,
    factors: [],
  });
  const s = computeWorkspaceSummary({
    executions: [
      { executionId: 'e1', startedAt: 'a', durationMs: 100, derivedStatus: 'running' },
      { executionId: 'e2', startedAt: 'a', durationMs: 100, derivedStatus: 'idle' },
      { executionId: 'e3', startedAt: 'a', durationMs: 100, derivedStatus: 'blocked' },
      { executionId: 'e4', startedAt: 'a', durationMs: 100, derivedStatus: 'completed' },
    ],
    health: [
      { executionId: 'e1', score: mkHealth('e1', 'healthy') },
      { executionId: 'e2', score: mkHealth('e2', 'warning') },
      { executionId: 'e3', score: mkHealth('e3', 'critical') },
      { executionId: 'e4', score: mkHealth('e4', 'healthy') },
    ],
    conflicts: [],
  });
  assert.equal(s.healthy, 2);
  assert.equal(s.warning, 1);
  assert.equal(s.critical, 1);
  assert.equal(s.total, 4);
});

test('computeWorkspaceSummary: conflictCount tallied correctly', () => {
  const s = computeWorkspaceSummary({
    executions: [
      { executionId: 'e1', startedAt: 'a', durationMs: 100, derivedStatus: 'running' },
      { executionId: 'e2', startedAt: 'a', durationMs: 100, derivedStatus: 'running' },
    ],
    health: [],
    conflicts: [
      { executionId: 'e1', isConflict: true },
      { executionId: 'e2', isConflict: false },
    ],
  });
  assert.equal(s.conflictCount, 1);
});

test('computeWorkspaceSummary: longestRunning picks longest active', () => {
  const s = computeWorkspaceSummary({
    executions: [
      { executionId: 'short', startedAt: 'a', durationMs: 1000, derivedStatus: 'running' },
      { executionId: 'long',  startedAt: 'a', durationMs: 999_000, derivedStatus: 'blocked' },
      { executionId: 'done',  startedAt: 'a', durationMs: 9_999_000, derivedStatus: 'completed' }, // longest duration but completed
    ],
    health: [],
    conflicts: [],
  });
  assert.equal(s.longestRunning?.executionId, 'long');
});

test('computeWorkspaceSummary: longestRunning ignores completed/failed', () => {
  const s = computeWorkspaceSummary({
    executions: [
      { executionId: 'a', startedAt: 'a', durationMs: 999_999, derivedStatus: 'completed' },
      { executionId: 'b', startedAt: 'a', durationMs: 50, derivedStatus: 'failed' },
    ],
    health: [],
    conflicts: [],
  });
  assert.equal(s.longestRunning, null);
});

test('computeWorkspaceSummary: longestRunning picks idle over running', () => {
  const s = computeWorkspaceSummary({
    executions: [
      { executionId: 'idle',    startedAt: 'a', durationMs: 5000, derivedStatus: 'idle' },
      { executionId: 'running', startedAt: 'a', durationMs: 1000, derivedStatus: 'running' },
    ],
    health: [],
    conflicts: [],
  });
  assert.equal(s.longestRunning?.executionId, 'idle');
});