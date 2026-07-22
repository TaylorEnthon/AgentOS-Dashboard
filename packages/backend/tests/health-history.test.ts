/**
 * v1.4 Health Memory & Trend tests.
 *
 * Covers:
 *  - HealthHistoryStore: shouldRecord (level / time / dedup), append/read, ring buffer
 *  - analyzeHealthTrend: empty / improving / degrading / stable
 *  - AttentionHistoryStore.reconcileFromQueue: detected / ongoing / recovered
 *  - computeAgentReliability: per-agent aggregation, recovery time
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHealthTrend,
  attentionHistoryStore as globalAttention,
  computeAgentReliability,
  createAttentionHistoryStore,
  createHealthHistoryStore,
  healthHistoryStore as globalHealth,
} from '../src/health-history.js';
import type {
  AgentType,
  AttentionItem,
  HealthLevel,
  HealthSnapshotHistory,
} from '@agentos/shared';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const EXEC = 'claude-code:abc:exec-0';

function mkSnap(overrides: Partial<HealthSnapshotHistory> = {}): HealthSnapshotHistory {
  return {
    executionId: EXEC,
    score: 80,
    level: 'healthy' as HealthLevel,
    derivedStatus: 'running',
    factors: [],
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function mkAttention(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    executionId: EXEC,
    severity: 'critical',
    reason: 'manual conflicts',
    recommendedAction: 'review-conflict',
    derivedStatus: 'running',
    detectedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/* ---------------- 1. HealthHistoryStore ---------------- */

test('shouldRecord: first entry (no prev) → true', () => {
  const s = createHealthHistoryStore();
  assert.equal(s.shouldRecord(null, { score: 80, level: 'healthy', derivedStatus: 'running', factors: [] }, NOW), true);
});

test('shouldRecord: level changed → true', () => {
  const s = createHealthHistoryStore();
  const prev = mkSnap({ level: 'healthy', createdAt: new Date(NOW - 1000).toISOString() });
  assert.equal(s.shouldRecord(prev, { score: 40, level: 'critical', derivedStatus: 'failed', factors: [] }, NOW), true);
});

test('shouldRecord: same level + too soon → false', () => {
  const s = createHealthHistoryStore({ minIntervalMs: 5 * 60_000 });
  const prev = mkSnap({ level: 'healthy', createdAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(s.shouldRecord(prev, { score: 82, level: 'healthy', derivedStatus: 'running', factors: [] }, NOW), false);
});

test('shouldRecord: same level + min interval elapsed → true (heartbeat)', () => {
  const s = createHealthHistoryStore({ minIntervalMs: 5 * 60_000 });
  const prev = mkSnap({ level: 'healthy', createdAt: new Date(NOW - 6 * 60_000).toISOString() });
  assert.equal(s.shouldRecord(prev, { score: 82, level: 'healthy', derivedStatus: 'running', factors: [] }, NOW), true);
});

test('HealthHistoryStore: append + read + latest', () => {
  const s = createHealthHistoryStore();
  s.append(EXEC, { score: 90, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: new Date(NOW).toISOString() });
  s.append(EXEC, { score: 30, level: 'critical', derivedStatus: 'failed', factors: [], createdAt: new Date(NOW + 1000).toISOString() });
  const all = s.read(EXEC);
  assert.equal(all.length, 2);
  assert.equal(s.latest(EXEC)?.score, 30);
});

test('HealthHistoryStore: ring buffer caps at maxEntries', () => {
  const s = createHealthHistoryStore({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) {
    s.append(EXEC, {
      score: 50 + i,
      level: 'warning',
      derivedStatus: 'idle',
      factors: [],
      createdAt: new Date(NOW + i * 1000).toISOString(),
    });
  }
  const all = s.read(EXEC);
  assert.equal(all.length, 3);
  assert.equal(all[0]!.score, 52); // first kept = i=2
});

test('HealthHistoryStore: clear empties everything', () => {
  const s = createHealthHistoryStore();
  s.append(EXEC, { score: 80, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: new Date(NOW).toISOString() });
  assert.equal(s.size(), 1);
  s.clear();
  assert.equal(s.size(), 0);
});

/* ---------------- 2. analyzeHealthTrend ---------------- */

test('analyzeHealthTrend: empty → stable with helpful summary', () => {
  const t = analyzeHealthTrend([], NOW);
  assert.equal(t.direction, 'stable');
  assert.equal(t.samples, 0);
  assert.equal(t.from, null);
  assert.match(t.summary, /No history/);
});

test('analyzeHealthTrend: single sample → stable, delta=0', () => {
  const t = analyzeHealthTrend([mkSnap({ score: 80 })], NOW);
  assert.equal(t.direction, 'stable');
  assert.equal(t.scoreDelta, 0);
  assert.equal(t.samples, 1);
});

test('analyzeHealthTrend: improving', () => {
  const t = analyzeHealthTrend([
    mkSnap({ score: 30, createdAt: new Date(NOW - 1000).toISOString() }),
    mkSnap({ score: 80, createdAt: new Date(NOW).toISOString() }),
  ], NOW);
  assert.equal(t.direction, 'improving');
  assert.equal(t.scoreDelta, 50);
  assert.equal(t.samples, 2);
  assert.match(t.summary, /Improving/);
});

test('analyzeHealthTrend: degrading', () => {
  const t = analyzeHealthTrend([
    mkSnap({ score: 90, createdAt: new Date(NOW - 1000).toISOString() }),
    mkSnap({ score: 40, createdAt: new Date(NOW).toISOString() }),
  ], NOW);
  assert.equal(t.direction, 'degrading');
  assert.equal(t.scoreDelta, -50);
  assert.match(t.summary, /Degrading/);
});

test('analyzeHealthTrend: stable when delta < 5', () => {
  const t = analyzeHealthTrend([
    mkSnap({ score: 80, createdAt: new Date(NOW - 1000).toISOString() }),
    mkSnap({ score: 82, createdAt: new Date(NOW).toISOString() }),
  ], NOW);
  assert.equal(t.direction, 'stable');
});

/* ---------------- 3. AttentionHistoryStore ---------------- */

test('AttentionHistoryStore: first reconciliation → all detected', () => {
  const s = createAttentionHistoryStore();
  const out = s.reconcileFromQueue([
    mkAttention({ recommendedAction: 'review-conflict' }),
    mkAttention({ recommendedAction: 'investigate-blocked', executionId: 'claude-code:abc:exec-1' }),
  ], new Date(NOW).toISOString());
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.lifecycle === 'detected'));
});

test('AttentionHistoryStore: same key still in queue → ongoing', () => {
  const s = createAttentionHistoryStore();
  const now1 = new Date(NOW).toISOString();
  s.reconcileFromQueue([mkAttention()], now1);
  const out = s.reconcileFromQueue([mkAttention()], new Date(NOW + 1000).toISOString());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lifecycle, 'ongoing');
});

test('AttentionHistoryStore: key leaves queue → recovered', () => {
  const s = createAttentionHistoryStore();
  s.reconcileFromQueue([mkAttention()], new Date(NOW).toISOString());
  const out = s.reconcileFromQueue([], new Date(NOW + 1000).toISOString());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lifecycle, 'recovered');
  assert.equal(out[0]!.reason, 'No longer in attention queue');
});

test('AttentionHistoryStore: recovered then re-detected → detected (new transition)', () => {
  const s = createAttentionHistoryStore();
  s.reconcileFromQueue([mkAttention()], new Date(NOW).toISOString());
  s.reconcileFromQueue([], new Date(NOW + 1000).toISOString());
  const out = s.reconcileFromQueue([mkAttention()], new Date(NOW + 2000).toISOString());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lifecycle, 'detected');
});

test('AttentionHistoryStore: stable key is idempotent on second reconcile', () => {
  const s = createAttentionHistoryStore();
  s.reconcileFromQueue([mkAttention()], new Date(NOW).toISOString());
  const out = s.reconcileFromQueue([mkAttention()], new Date(NOW + 100).toISOString());
  // Still emits 'ongoing' (heartbeat); subsequent calls also 'ongoing'.
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lifecycle, 'ongoing');
});

test('AttentionHistoryStore: read returns chronological', () => {
  const s = createAttentionHistoryStore();
  s.reconcileFromQueue([mkAttention()], new Date(NOW).toISOString());
  s.reconcileFromQueue([], new Date(NOW + 1000).toISOString());
  const history = s.read(EXEC);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.lifecycle, 'detected');
  assert.equal(history[1]!.lifecycle, 'recovered');
});

/* ---------------- 4. computeAgentReliability ---------------- */

test('computeAgentReliability: empty → no agents', () => {
  const out = computeAgentReliability([], new Map(), NOW);
  assert.equal(out.length, 0);
});

test('computeAgentReliability: groups by agentType', () => {
  const history: HealthSnapshotHistory[] = [
    mkSnap({ executionId: 'claude-code:a:exec-0', score: 80, level: 'healthy', derivedStatus: 'completed' }),
    mkSnap({ executionId: 'codex:b:exec-0',       score: 30, level: 'critical', derivedStatus: 'failed' }),
  ];
  const agents = new Map<string, AgentType>([
    ['claude-code:a:exec-0', 'claude-code'],
    ['codex:b:exec-0', 'codex'],
  ]);
  const out = computeAgentReliability(history, agents, NOW);
  assert.equal(out.length, 2);
  const byAgent = new Map(out.map((o) => [o.agentType, o]));
  assert.equal(byAgent.get('claude-code')?.reliabilityScore, 100); // 0 failures
  assert.equal(byAgent.get('codex')?.reliabilityScore, 0);        // 100% failure rate
});

test('computeAgentReliability: failureRate is 0..1', () => {
  const history: HealthSnapshotHistory[] = [
    mkSnap({ score: 30, derivedStatus: 'failed' }),
    mkSnap({ score: 80, derivedStatus: 'completed' }),
    mkSnap({ score: 80, derivedStatus: 'completed' }),
    mkSnap({ score: 80, derivedStatus: 'completed' }),
  ];
  const agents = new Map<string, AgentType>([[EXEC, 'claude-code']]);
  const out = computeAgentReliability(history, agents, NOW);
  assert.equal(out[0]!.failureRate, 0.25);
  assert.equal(out[0]!.reliabilityScore, 75);
  assert.equal(out[0]!.failedExecutions, 1);
  assert.equal(out[0]!.completedExecutions, 3);
});

test('computeAgentReliability: recovery time from failed→completed pairs', () => {
  const history: HealthSnapshotHistory[] = [
    mkSnap({ score: 30, derivedStatus: 'failed',    createdAt: new Date(NOW - 60_000).toISOString() }),
    mkSnap({ score: 80, derivedStatus: 'completed', createdAt: new Date(NOW).toISOString() }),
  ];
  const agents = new Map<string, AgentType>([[EXEC, 'claude-code']]);
  const out = computeAgentReliability(history, agents, NOW);
  assert.equal(out[0]!.averageRecoveryTimeMs, 60_000);
});

test('computeAgentReliability: failed without recovery → null recovery time', () => {
  const history: HealthSnapshotHistory[] = [
    mkSnap({ score: 30, derivedStatus: 'failed', createdAt: new Date(NOW - 1000).toISOString() }),
  ];
  const agents = new Map<string, AgentType>([[EXEC, 'claude-code']]);
  const out = computeAgentReliability(history, agents, NOW);
  assert.equal(out[0]!.averageRecoveryTimeMs, null);
});

test('computeAgentReliability: sorted by reliabilityScore desc', () => {
  const history: HealthSnapshotHistory[] = [
    mkSnap({ executionId: 'claude-code:bad',  score: 0,  derivedStatus: 'failed' }),
    mkSnap({ executionId: 'codex:good',       score: 100, derivedStatus: 'completed' }),
  ];
  const agents = new Map<string, AgentType>([
    ['claude-code:bad', 'claude-code'],
    ['codex:good', 'codex'],
  ]);
  const out = computeAgentReliability(history, agents, NOW);
  assert.equal(out[0]!.agentType, 'codex');
  assert.equal(out[1]!.agentType, 'claude-code');
});

/* ---------------- 5. integration: store + analyze ---------------- */

test('integration: append + read + trend together', () => {
  globalHealth.clear();
  globalHealth.append(EXEC, { score: 50, level: 'warning', derivedStatus: 'idle', factors: [], createdAt: new Date(NOW - 10_000).toISOString() });
  globalHealth.append(EXEC, { score: 70, level: 'warning', derivedStatus: 'running', factors: [], createdAt: new Date(NOW - 5_000).toISOString() });
  globalHealth.append(EXEC, { score: 90, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: new Date(NOW).toISOString() });
  const history = globalHealth.read(EXEC);
  assert.equal(history.length, 3);
  const trend = analyzeHealthTrend(history, NOW);
  assert.equal(trend.direction, 'improving');
  assert.equal(trend.scoreDelta, 40);
  globalHealth.clear();
});

test('integration: attention reconcile + history read', () => {
  globalAttention.clear();
  globalAttention.reconcileFromQueue([
    mkAttention({ recommendedAction: 'review-conflict' }),
  ], new Date(NOW).toISOString());
  const detected = globalAttention.read(EXEC);
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.lifecycle, 'detected');
  globalAttention.reconcileFromQueue([], new Date(NOW + 1000).toISOString());
  const all = globalAttention.read(EXEC);
  assert.equal(all.length, 2);
  assert.equal(all[1]!.lifecycle, 'recovered');
  globalAttention.clear();
});