/**
 * v1.10 Incident Temporal Intelligence pure-function tests.
 *
 * Covers:
 *  - filterIncidentsByWindow: time-window filter, boundaries, empty
 *  - summarizeWindow: workspace temporal snapshot
 *  - buildAgentTrend: per-agent trend with direction (improving /
 *    stable / degrading / no-data)
 *  - buildAllAgentTrends: workspace trends sorted by incidentCount
 *  - detectBurst: same-kind spike detection
 *  - detectAgentDegradation: multi-execution agent detection
 *  - detectIntelligenceSignals: combined signal detector
 *  - Determinism
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentTrend,
  buildAllAgentTrends,
  detectAgentDegradation,
  detectBurst,
  detectIntelligenceSignals,
  filterIncidentsByWindow,
  summarizeWindow,
} from '../src/incident-temporal.js';
import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
} from '@agentos/shared';

let counter = 0;
function incAt(args: {
  executionId: string;
  kind: HealthAnomalyKind;
  minutesAgo: number;
  severity?: HealthAnomalySeverity;
  lifecycle?: 'detected' | 'ongoing' | 'recovered';
}): HealthIncident {
  counter += 1;
  const ts = new Date(Date.UTC(2026, 6, 23, 12, 0, 0) - args.minutesAgo * 60_000).toISOString();
  return {
    incidentKey: `${args.executionId}|${args.kind}`,
    executionId: args.executionId,
    kind: args.kind,
    severity: args.severity ?? 'high',
    initialSeverity: 'high',
    currentSeverity: args.lifecycle === 'recovered' ? 'low' : (args.severity ?? 'high'),
    maxSeverity: args.severity ?? 'high',
    escalationCount: 0,
    detectedAt: ts,
    lastTransitionAt: ts,
    lifecycle: args.lifecycle ?? 'detected',
    recoveredAt: args.lifecycle === 'recovered' ? ts : null,
    durationMs: args.lifecycle === 'recovered' ? 60_000 : null,
    reason: `[${args.kind}] test`,
  };
}

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);

/* ---------------- filterIncidentsByWindow ---------------- */

test('filterIncidentsByWindow: half-open [since, until) on detectedAt', () => {
  const inc1 = incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 120 }); // 2h ago
  const inc2 = incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 30 });  // 30m ago
  const inc3 = incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 0 });    // now
  const since = new Date(NOON - 60 * 60_000).toISOString();   // 1h ago
  const until = new Date(NOON).toISOString();                // now
  const out = filterIncidentsByWindow([inc1, inc2, inc3], { sinceIso: since, untilIso: until });
  assert.deepEqual(out.map((i) => i.executionId), ['e2']);
});

test('filterIncidentsByWindow: since only → open on past', () => {
  const inc1 = incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 30 });
  const since = new Date(NOON - 60 * 60_000).toISOString();
  const out = filterIncidentsByWindow([inc1], { sinceIso: since });
  assert.equal(out.length, 1);
});

test('filterIncidentsByWindow: until only → open on future', () => {
  const inc1 = incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 30 });
  const until = new Date(NOON - 60 * 60_000).toISOString();
  const out = filterIncidentsByWindow([inc1], { untilIso: until });
  assert.equal(out.length, 0);
});

test('filterIncidentsByWindow: empty input → []', () => {
  assert.deepEqual(filterIncidentsByWindow([], { sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' }), []);
});

test('filterIncidentsByWindow: boundary — since is inclusive, until is exclusive', () => {
  const on = new Date(NOON).toISOString();
  const inc = incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 0 });
  // Adjust inc to be exactly at the boundary
  inc.detectedAt = on;
  // since = on, until = on + 1ms → inc should be included
  const out = filterIncidentsByWindow([inc], { sinceIso: on, untilIso: new Date(NOON + 1).toISOString() });
  assert.equal(out.length, 1);
  // until = on (exact) → inc NOT included (exclusive upper)
  const out2 = filterIncidentsByWindow([inc], { sinceIso: on, untilIso: on });
  assert.equal(out2.length, 0);
});

/* ---------------- summarizeWindow ---------------- */

test('summarizeWindow: counts active vs recovered and severity distribution', () => {
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 30, severity: 'critical', lifecycle: 'detected' }),
    incAt({ executionId: 'e2', kind: 'level-regression', minutesAgo: 25, severity: 'high',     lifecycle: 'ongoing' }),
    incAt({ executionId: 'e3', kind: 'score-drop',       minutesAgo: 20, severity: 'high',     lifecycle: 'recovered' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'codex'], ['e3', 'claude-code']]);
  const since = new Date(NOON - 60 * 60_000).toISOString();
  const until = new Date(NOON).toISOString();
  const out = summarizeWindow(incidents, map, { sinceIso: since, untilIso: until });
  assert.equal(out.incidentCount, 3);
  assert.equal(out.activeCount, 2);
  assert.equal(out.recoveredCount, 1);
  assert.equal(out.criticalCount, 1);
  assert.equal(out.highCount, 2);
  assert.equal(out.byKind.length, 2);
  assert.equal(out.byAgent.length, 2);
  assert.ok(out.densityPerHour > 0);
});

test('summarizeWindow: empty window → zeros', () => {
  const out = summarizeWindow([], new Map(), { sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' });
  assert.equal(out.incidentCount, 0);
  assert.equal(out.criticalCount, 0);
  assert.equal(out.densityPerHour, 0);
});

/* ---------------- buildAgentTrend ---------------- */

test('buildAgentTrend: improving — current window smaller than previous', () => {
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const now = NOON;
  // since = 30 min ago, until = now. windowMs = 30min. previous window = [60, 30) min ago.
  const since = new Date(now - 30 * 60_000).toISOString();
  const until = new Date(now).toISOString();
  // previous window (60..30 min ago): 5 incidents
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 55 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 50 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 45 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 40 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 35 }),
    // current window (30..0 min ago): 1 incident
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 10 }),
  ];
  const out = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  assert.equal(out.trendDirection, 'improving');
  assert.ok(out.incidentDelta < 0);
});

test('buildAgentTrend: degrading — current window larger than previous', () => {
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const now = NOON;
  const since = new Date(now - 30 * 60_000).toISOString();
  const until = new Date(now).toISOString();
  const incidents = [
    // previous: 1
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 35 }),
    // current: 4
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 25 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 20 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 15 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 10 }),
  ];
  const out = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  assert.equal(out.trendDirection, 'degrading');
  assert.ok(out.incidentDelta > 0);
});

test('buildAgentTrend: stable — within threshold', () => {
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const now = NOON;
  const since = new Date(now - 30 * 60_000).toISOString();
  const until = new Date(now).toISOString();
  // previous 5, current 5 — no change
  const incidents: HealthIncident[] = [];
  for (let i = 0; i < 5; i++) {
    incidents.push(incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 35 + i * 2 }));
    incidents.push(incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 10 + i * 2 }));
  }
  const out = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  assert.equal(out.trendDirection, 'stable');
  assert.equal(out.incidentDelta, 0);
});

test('buildAgentTrend: no-data — both windows empty', () => {
  const map = new Map<string, string>();
  const out = buildAgentTrend('claude-code', [], map, {
    sinceIso: '2026-01-01T00:00:00.000Z',
    untilIso: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(out.trendDirection, 'no-data');
});

test('buildAgentTrend: critical-only delta triggers degrading', () => {
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const now = NOON;
  const since = new Date(now - 30 * 60_000).toISOString();
  const until = new Date(now).toISOString();
  const incidents: HealthIncident[] = [];
  // previous: 5 high
  for (let i = 0; i < 5; i++) {
    incidents.push(incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 35 + i * 2, severity: 'high' }));
  }
  // current: 5 critical (same count but severity went up)
  for (let i = 0; i < 5; i++) {
    incidents.push(incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 10 + i * 2, severity: 'critical' }));
  }
  const out = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  assert.equal(out.trendDirection, 'degrading');
  assert.equal(out.criticalDelta, 5);
});

test('buildAgentTrend: deterministic — same input yields same output', () => {
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 30 }),
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 130 }),
  ];
  const since = '2026-07-23T11:00:00.000Z';
  const until = '2026-07-23T12:00:00.000Z';
  const a = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  const b = buildAgentTrend('claude-code', incidents, map, { sinceIso: since, untilIso: until });
  assert.deepEqual(a, b);
});

/* ---------------- buildAllAgentTrends ---------------- */

test('buildAllAgentTrends: returns one row per affected agent, sorted by incidentCount desc', () => {
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'codex'], ['e3', 'claude-code']]);
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 30 }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 25 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 20 }),
  ];
  const out = buildAllAgentTrends(incidents, map, {
    sinceIso: '2026-07-23T11:00:00.000Z',
    untilIso: '2026-07-23T12:00:00.000Z',
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.agentType, 'claude-code');
  assert.equal(out[0]!.incidentCount, 2);
  assert.equal(out[0]!.rankByIncidentCount, 1);
  assert.equal(out[1]!.agentType, 'codex');
  assert.equal(out[1]!.rankByIncidentCount, 2);
});

/* ---------------- detectBurst ---------------- */

test('detectBurst: ≥3 same-kind incidents in window → burst signal', () => {
  const now = NOON;
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10 }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15 }),
  ];
  const out = detectBurst(incidents, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'burst');
  assert.equal(out[0]!.subjectKey, 'score-drop');
  assert.equal(out[0]!.score, 3);
});

test('detectBurst: < threshold → no signal', () => {
  const now = NOON;
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10 }),
  ];
  const out = detectBurst(incidents, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out.length, 0);
});

test('detectBurst: critical in burst → severity=alert', () => {
  const now = NOON;
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5,  severity: 'critical' }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10, severity: 'high' }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15, severity: 'high' }),
  ];
  const out = detectBurst(incidents, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out[0]!.severity, 'alert');
});

test('detectBurst: outside window → no signal (false positive guard)', () => {
  const now = NOON;
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 90 }),  // outside 60m window
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 100 }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 110 }),
  ];
  const out = detectBurst(incidents, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out.length, 0);
});

/* ---------------- detectAgentDegradation ---------------- */

test('detectAgentDegradation: ≥3 affected executions in window → degradation signal', () => {
  const now = NOON;
  const map = new Map<string, string>([
    ['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'claude-code'], ['e4', 'claude-code'],
  ]);
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10 }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15 }),
  ];
  const out = detectAgentDegradation(incidents, map, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'agent-degradation');
  assert.equal(out[0]!.subjectKey, 'claude-code');
  assert.equal(out[0]!.score, 3);
});

test('detectAgentDegradation: < threshold → no signal', () => {
  const now = NOON;
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code']]);
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10 }),
  ];
  const out = detectAgentDegradation(incidents, map, { nowMs: now, windowMs: 60 * 60_000, threshold: 3 });
  assert.equal(out.length, 0);
});

/* ---------------- detectIntelligenceSignals ---------------- */

test('detectIntelligenceSignals: combines burst + agent-degradation + recovery-surge', () => {
  const now = NOON;
  const map = new Map<string, string>([
    ['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'claude-code'],
  ]);
  const incidents = [
    incAt({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5 }),
    incAt({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10 }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15 }),
    incAt({ executionId: 'e1', kind: 'level-regression', minutesAgo: 20, lifecycle: 'recovered' }),
    incAt({ executionId: 'e2', kind: 'rapid-degradation', minutesAgo: 25, lifecycle: 'recovered' }),
    incAt({ executionId: 'e3', kind: 'score-drop', minutesAgo: 30, lifecycle: 'recovered' }),
  ];
  const out = detectIntelligenceSignals(incidents, map, {
    nowMs: now,
    burstWindowMs: 60 * 60_000,
    burstThreshold: 3,
    agentWindowMs: 60 * 60_000,
    agentThreshold: 3,
  });
  // Should have: burst(score-drop), agent-degradation(claude-code), recovery-surge
  assert.ok(out.signals.length >= 2, `expected ≥2 signals, got ${out.signals.length}`);
  const kinds = new Set(out.signals.map((s) => s.kind));
  assert.ok(kinds.has('burst'));
  assert.ok(kinds.has('agent-degradation'));
});

test('detectIntelligenceSignals: empty input → empty signals, highestSeverity=null', () => {
  const out = detectIntelligenceSignals([], new Map(), { nowMs: NOON });
  assert.equal(out.signals.length, 0);
  assert.equal(out.highestSeverity, null);
  assert.equal(out.totalCount, 0);
});