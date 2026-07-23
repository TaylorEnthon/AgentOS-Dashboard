/**
 * v1.11 Incident Intelligence Prioritization pure-function tests.
 *
 * Covers:
 *  - buildPriority: score + level + reasons + trend hint
 *  - Score components: severity / frequency / impact / trend
 *  - Priority level mapping: critical / high / medium / low
 *  - Evidence chain: severity / frequency / impact / trend
 *  - buildPriorities: workspace rollup, sorted, top-N
 *  - Determinism
 *  - Edge cases: empty signals, info severity → low
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPriorities,
  buildPriority,
} from '../src/incident-priority.js';
import type {
  AgentReliabilityTrend,
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IntelligenceSignal,
  IntelligenceSignalKind,
  IntelligenceSignalSeverity,
  TrendDirection,
} from '@agentos/shared';

let counter = 0;
function signal(args: {
  kind: IntelligenceSignalKind;
  severity: IntelligenceSignalSeverity;
  subjectKey: string;
  score: number;
  threshold: number;
  since?: string;
  until?: string;
}): IntelligenceSignal {
  return {
    signalId: `${args.kind}:${args.subjectKey}:${counter++}`,
    kind: args.kind,
    severity: args.severity,
    subjectKey: args.subjectKey,
    subjectLabel: args.subjectKey,
    since: args.since ?? '2026-07-23T11:00:00.000Z',
    until: args.until ?? '2026-07-23T12:00:00.000Z',
    score: args.score,
    threshold: args.threshold,
    description: `${args.kind} on ${args.subjectKey} (score ${args.score})`,
  };
}

let incCounter = 0;
function inc(args: {
  executionId: string;
  kind: HealthAnomalyKind;
  minutesAgo: number;
  severity?: HealthAnomalySeverity;
  agentType?: AgentType;
}): HealthIncident {
  incCounter += 1;
  return {
    incidentKey: `${args.executionId}|${args.kind}`,
    executionId: args.executionId,
    kind: args.kind,
    severity: args.severity ?? 'high',
    initialSeverity: 'high',
    currentSeverity: args.severity ?? 'high',
    maxSeverity: args.severity ?? 'high',
    escalationCount: 0,
    detectedAt: new Date(Date.UTC(2026, 6, 23, 12, 0, 0) - args.minutesAgo * 60_000).toISOString(),
    lastTransitionAt: null,
    lifecycle: 'detected',
    recoveredAt: null,
    durationMs: null,
    reason: `[${args.kind}] test`,
  };
}

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);

function windowIncidents(): HealthIncident[] {
  return [
    inc({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 10, severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'score-drop',       minutesAgo: 15, severity: 'critical' }),
    inc({ executionId: 'e3', kind: 'score-drop',       minutesAgo: 20, severity: 'high' }),
    inc({ executionId: 'e4', kind: 'score-drop',       minutesAgo: 25, severity: 'high' }),
    inc({ executionId: 'e5', kind: 'level-regression', minutesAgo: 12, severity: 'critical' }),
    inc({ executionId: 'e6', kind: 'level-regression', minutesAgo: 17, severity: 'high' }),
    inc({ executionId: 'e7', kind: 'level-regression', minutesAgo: 22, severity: 'high' }),
  ];
}

function execToAgent(): Map<string, string> {
  return new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'claude-code'],
    ['e3', 'claude-code'],
    ['e4', 'codex'],
    ['e5', 'claude-code'],
    ['e6', 'claude-code'],
    ['e7', 'codex'],
  ]);
}

function agentTrend(args: {
  agentType: string;
  trendDirection: TrendDirection;
  criticalCount?: number;
}): AgentReliabilityTrend {
  return {
    agentType: args.agentType,
    since: '2026-07-23T11:00:00.000Z',
    until: '2026-07-23T12:00:00.000Z',
    windowMs: 60 * 60_000,
    executionCount: 4,
    affectedExecutions: 4,
    incidentCount: 4,
    activeCount: 4,
    recoveredCount: 0,
    criticalCount: args.criticalCount ?? 0,
    highCount: 4,
    totalEscalations: 0,
    worstSeverity: 'critical',
    degradationRate: 1,
    trendDirection: args.trendDirection,
    incidentDelta: 0,
    criticalDelta: 0,
    rankByIncidentCount: null,
  };
}

/* ---------------- single priority ---------------- */

test('priority: critical alert burst → high score + critical level', () => {
  const sig = signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop', score: 5, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // score-drop: 4 execs, 2 agents (claude-code, codex) → impact = min(30, 4*5 + 2*10) = 30
  // severity(40) + frequency(10) + impact(30) = 80
  assert.equal(p.priorityScore, 80);
  assert.equal(p.priorityLevel, 'critical');
  // reasons: severity, frequency, impact should be present
  const kinds = p.reasons.map((r) => r.kind);
  assert.ok(kinds.includes('severity'));
  assert.ok(kinds.includes('frequency'));
  assert.ok(kinds.includes('impact'));
});

test('priority: low risk signal → low level', () => {
  const sig = signal({ kind: 'recovery-surge', severity: 'info', subjectKey: 'global', score: 3, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // info severity = 0, frequency (only burst) = 0, impact = 0
  // trend (no agent) = 0 → total 0
  assert.equal(p.priorityScore, 0);
  assert.equal(p.priorityLevel, 'low');
});

test('priority: high-severity warn signal (no burst) → medium/high level', () => {
  const sig = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [agentTrend({ agentType: 'claude-code', trendDirection: 'stable' })],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // severity(20) + impact(cap 30) + trend(5, stable) = 55
  assert.equal(p.priorityScore, 55);
  assert.equal(p.priorityLevel, 'high');
});

test('priority: degrading trend adds 20 points', () => {
  const sig = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 });
  const pDegrading = buildPriority({
    signal: sig,
    agentTrends: [agentTrend({ agentType: 'claude-code', trendDirection: 'degrading' })],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  const pNoTrend = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // Degrading trend adds 20 points.
  assert.equal(pDegrading.priorityScore - pNoTrend.priorityScore, 20);
  assert.equal(pDegrading.trendHint, 'degrading');
});

test('priority: trend hint is null for non-agent signals', () => {
  const sig = signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop', score: 5, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [agentTrend({ agentType: 'claude-code', trendDirection: 'degrading' })],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // burst is kind-keyed, not agent-keyed → trendHint is null
  assert.equal(p.trendHint, null);
});

test('priority: deterministic — same input yields same output', () => {
  const sig = signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop', score: 5, threshold: 3 });
  const args = {
    signal: sig,
    agentTrends: [] as AgentReliabilityTrend[],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  };
  const a = buildPriority(args);
  const b = buildPriority(args);
  assert.deepEqual(a, b);
});

/* ---------------- evidence chain ---------------- */

test('evidence: severity evidence appears for alert signal', () => {
  const sig = signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop', score: 5, threshold: 3 });
  const p = buildPriority({ signal: sig, agentTrends: [], windowIncidents: windowIncidents(), executionToAgent: execToAgent() });
  const sev = p.reasons.find((r) => r.kind === 'severity');
  assert.ok(sev);
  assert.equal(sev!.contribution, 40);
  assert.ok(sev!.message.includes('alert'));
});

test('evidence: frequency evidence appears only for burst signal', () => {
  const sigBurst = signal({ kind: 'burst', severity: 'warn', subjectKey: 'score-drop', score: 5, threshold: 3 });
  const pBurst = buildPriority({ signal: sigBurst, agentTrends: [], windowIncidents: windowIncidents(), executionToAgent: execToAgent() });
  assert.ok(pBurst.reasons.some((r) => r.kind === 'frequency'));

  const sigAgent = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 });
  const pAgent = buildPriority({ signal: sigAgent, agentTrends: [], windowIncidents: windowIncidents(), executionToAgent: execToAgent() });
  assert.ok(!pAgent.reasons.some((r) => r.kind === 'frequency'));
});

test('evidence: trend evidence appears when trendHint is set', () => {
  const sig = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [agentTrend({ agentType: 'claude-code', trendDirection: 'degrading' })],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  const trend = p.reasons.find((r) => r.kind === 'trend');
  assert.ok(trend);
  assert.equal(trend!.contribution, 20);
  assert.ok(trend!.message.includes('degrading'));
});

test('evidence: impact evidence scales with affectedExecutions + affectedAgents', () => {
  const sig = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  const impact = p.reasons.find((r) => r.kind === 'impact');
  assert.ok(impact);
  // claude-code has 5 execs (e1, e2, e3, e5, e6) → 5*5 + 1*10 = 35 → cap at 30
  assert.equal(impact!.contribution, 30);
});

test('evidence: impact is capped at 30', () => {
  // 10 execs × 5 + 5 agents × 10 = 100 → capped at 30
  const many = Array.from({ length: 10 }, (_, i) => inc({ executionId: `e${i}`, kind: 'score-drop', minutesAgo: 10 }));
  const map = new Map<string, string>(Array.from({ length: 10 }, (_, i) => [`e${i}`, i % 2 === 0 ? 'claude-code' : 'codex'] as [string, string]));
  const sig = signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 10, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: many,
    executionToAgent: map,
  });
  const impact = p.reasons.find((r) => r.kind === 'impact');
  assert.ok(impact);
  assert.equal(impact!.contribution, 30);
});

test('evidence: base evidence appears when no other fires (low score)', () => {
  // No agent-keyed signal, no burst, severity = info → all components = 0
  const sig = signal({ kind: 'recovery-surge', severity: 'info', subjectKey: 'global', score: 3, threshold: 3 });
  const p = buildPriority({
    signal: sig,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // No incidents are 'recovered' so affectedExecutions = 0, affectedAgents = 0
  // All 0 → no severity / frequency / impact / trend evidence → base placeholder
  const base = p.reasons.find((r) => r.kind === 'base');
  assert.ok(base);
});

/* ---------------- workspace summary ---------------- */

test('buildPriorities: empty signals → empty result, highestLevel=null', () => {
  const out = buildPriorities({
    signals: [],
    agentTrends: [],
    windowIncidents: [],
    executionToAgent: new Map(),
  });
  assert.equal(out.priorities.length, 0);
  assert.equal(out.highestLevel, null);
  assert.equal(out.totalCount, 0);
  assert.equal(out.byLevel.critical, 0);
});

test('buildPriorities: sorts by priorityLevel desc, then score desc', () => {
  const signals = [
    signal({ kind: 'burst', severity: 'warn',  subjectKey: 'level-regression', score: 3, threshold: 3 }),
    signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop',       score: 4, threshold: 3 }),
    signal({ kind: 'agent-degradation', severity: 'info', subjectKey: 'codex',       score: 5, threshold: 3 }),
  ];
  const out = buildPriorities({
    signals,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // First should be the alert burst (highest level)
  assert.equal(out.priorities[0]!.priorityLevel, 'critical');
  assert.equal(out.priorities[0]!.subjectKey, 'score-drop');
});

test('buildPriorities: respects topN cap', () => {
  const signals = Array.from({ length: 10 }, (_, i) =>
    signal({ kind: 'burst', severity: 'alert', subjectKey: `kind-${i}`, score: 5, threshold: 3 }),
  );
  const out = buildPriorities({
    signals,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
    topN: 3,
  });
  assert.equal(out.priorities.length, 3);
  assert.equal(out.totalCount, 10);
});

test('buildPriorities: byLevel counts match priorities', () => {
  const signals = [
    signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop',       score: 5, threshold: 3 }),
    signal({ kind: 'burst', severity: 'warn',  subjectKey: 'level-regression', score: 3, threshold: 3 }),
    signal({ kind: 'agent-degradation', severity: 'info', subjectKey: 'codex',         score: 3, threshold: 3 }),
  ];
  const out = buildPriorities({
    signals,
    agentTrends: [],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
  });
  // alert burst score-drop       → critical (40+10+30 = 80)
  // warn  burst level-regression  → high    (20+10+30 = 60)
  // info  agent-degradation codex → low     (0+0+2*5+1*10 = 20, level=low)
  assert.equal(out.byLevel.critical, 1);
  assert.equal(out.byLevel.high, 1);
  assert.equal(out.byLevel.medium, 0);
  assert.equal(out.byLevel.low, 1);
  assert.equal(out.highestLevel, 'critical');
});

test('buildPriorities: deterministic — same input yields same output', () => {
  const signals = [
    signal({ kind: 'burst', severity: 'alert', subjectKey: 'score-drop', score: 4, threshold: 3 }),
    signal({ kind: 'agent-degradation', severity: 'warn', subjectKey: 'claude-code', score: 3, threshold: 3 }),
  ];
  const args = {
    signals,
    agentTrends: [agentTrend({ agentType: 'claude-code', trendDirection: 'degrading' })],
    windowIncidents: windowIncidents(),
    executionToAgent: execToAgent(),
    topN: 5,
    nowMs: NOON,
  };
  const a = buildPriorities(args);
  const b = buildPriorities(args);
  assert.deepEqual(a, b);
});