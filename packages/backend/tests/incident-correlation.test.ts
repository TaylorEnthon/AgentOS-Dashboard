/**
 * v1.9 Incident Correlation pure-function tests.
 *
 * Covers:
 *  - aggregateByExecution: per-execution aggregation
 *  - aggregateByKind: per-kind aggregation
 *  - aggregateByAgent: per-agent aggregation (with exec→agent map)
 *  - buildCorrelations: cross-cutting agent / kind / agent-kind dimensions
 *  - buildCorrelationSummary: workspace rollup
 *  - buildExecutionToAgentMap: helper
 *  - determinism
 *  - empty input
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByAgent,
  aggregateByExecution,
  aggregateByKind,
  buildCorrelationSummary,
  buildCorrelations,
  buildExecutionToAgentMap,
} from '../src/incident-correlation.js';
import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
} from '@agentos/shared';

let counter = 0;
function incident(args: Partial<HealthIncident> & { executionId: string; kind: HealthAnomalyKind }): HealthIncident {
  counter += 1;
  return {
    incidentKey: `${args.executionId}|${args.kind}`,
    executionId: args.executionId,
    kind: args.kind,
    severity: args.severity ?? 'high',
    initialSeverity: args.initialSeverity ?? 'high',
    currentSeverity: args.currentSeverity ?? 'high',
    maxSeverity: args.maxSeverity ?? 'high',
    escalationCount: args.escalationCount ?? 0,
    detectedAt: args.detectedAt ?? `2026-07-23T10:${String(counter % 60).padStart(2, '0')}:00.000Z`,
    lastTransitionAt: args.lastTransitionAt ?? null,
    lifecycle: args.lifecycle ?? 'detected',
    recoveredAt: args.recoveredAt ?? null,
    durationMs: args.durationMs ?? null,
    reason: args.reason ?? `[${args.kind}] test`,
  };
}

/* ---------------- aggregateByExecution ---------------- */

test('aggregateByExecution: empty input → []', () => {
  assert.deepEqual(aggregateByExecution([]), []);
});

test('aggregateByExecution: counts incidents per execution', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop', lifecycle: 'detected' }),
    incident({ executionId: 'e1', kind: 'level-regression', lifecycle: 'detected' }),
    incident({ executionId: 'e2', kind: 'score-drop', lifecycle: 'recovered' }),
  ];
  const out = aggregateByExecution(incidents);
  assert.equal(out.length, 2);
  const e1 = out.find((o) => o.executionId === 'e1');
  assert.ok(e1);
  assert.equal(e1!.incidents, 2);
  assert.equal(e1!.active, 2);
  assert.equal(e1!.recovered, 0);
  assert.deepEqual(e1!.kinds.sort(), ['level-regression', 'score-drop']);
  assert.equal(e1!.worstSeverity, 'high');
});

test('aggregateByExecution: escalations sum', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop', escalationCount: 2 }),
    incident({ executionId: 'e1', kind: 'level-regression', escalationCount: 1 }),
  ];
  const out = aggregateByExecution(incidents);
  assert.equal(out[0]!.totalEscalations, 3);
});

test('aggregateByExecution: worstSeverity picks critical when present', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop', severity: 'high',     maxSeverity: 'high' }),
    incident({ executionId: 'e1', kind: 'level-regression', severity: 'critical', maxSeverity: 'critical' }),
  ];
  const out = aggregateByExecution(incidents);
  assert.equal(out[0]!.worstSeverity, 'critical');
});

/* ---------------- aggregateByKind ---------------- */

test('aggregateByKind: empty input → []', () => {
  assert.deepEqual(aggregateByKind([]), []);
});

test('aggregateByKind: counts per kind', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
    incident({ executionId: 'e3', kind: 'level-regression' }),
  ];
  const out = aggregateByKind(incidents);
  assert.equal(out.length, 2);
  const score = out.find((o) => o.kind === 'score-drop');
  assert.ok(score);
  assert.equal(score!.incidentCount, 2);
  assert.equal(score!.affectedExecutions, 2);
});

test('aggregateByKind: affectedExecutions counts unique execIds', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e1', kind: 'score-drop', lifecycle: 'recovered' }),
  ];
  // Note: both have same incidentKey so this test relies on different counter ids.
  // Here we construct two incidents for the same (exec, kind) but they
  // should still represent the same single incident from the system's POV.
  // For aggregation purposes we count both rows; let's keep it simple.
  const out = aggregateByKind(incidents);
  assert.equal(out[0]!.incidentCount, 2);
  assert.equal(out[0]!.affectedExecutions, 1);
});

/* ---------------- aggregateByAgent ---------------- */

test('aggregateByAgent: empty input → []', () => {
  assert.deepEqual(aggregateByAgent([], new Map()), []);
});

test('aggregateByAgent: skips incidents with unknown agent', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
  ];
  const map = new Map([['e1', 'claude-code' as AgentType]]);
  const out = aggregateByAgent(incidents, map);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.agentType, 'claude-code');
  assert.equal(out[0]!.affectedExecutions, 1);
});

test('aggregateByAgent: aggregates across multiple executions', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
    incident({ executionId: 'e3', kind: 'level-regression' }),
    incident({ executionId: 'e4', kind: 'score-drop', severity: 'critical' }),
  ];
  const map = new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'claude-code'],
    ['e3', 'claude-code'],
    ['e4', 'codex'],
  ]);
  const out = aggregateByAgent(incidents, map);
  assert.equal(out.length, 2);
  const claude = out.find((o) => o.agentType === 'claude-code');
  assert.ok(claude);
  assert.equal(claude!.incidentCount, 3);
  assert.equal(claude!.affectedExecutions, 3);
  const codex = out.find((o) => o.agentType === 'codex');
  assert.ok(codex);
  assert.equal(codex!.incidentCount, 1);
  assert.equal(codex!.worstSeverity, 'critical');
  assert.equal(codex!.criticalCount, 1);
});

test('aggregateByAgent: deterministic — same input yields same output', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'level-regression' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code']]);
  const a = aggregateByAgent(incidents, map, { nowMs: 1 });
  const b = aggregateByAgent(incidents, map, { nowMs: 9_999_999_999 });
  // nowMs doesn't affect this aggregation
  assert.deepEqual(a, b);
});

/* ---------------- buildCorrelations ---------------- */

test('buildCorrelations: empty input → []', () => {
  assert.deepEqual(buildCorrelations([], new Map()), []);
});

test('buildCorrelations: agent dimension correlates by agent', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'level-regression' }),
    incident({ executionId: 'e3', kind: 'score-drop' }),
  ];
  const map = new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'claude-code'],
    ['e3', 'codex'],
  ]);
  const out = buildCorrelations(incidents, map);
  const agentCorrs = out.filter((c) => c.dimension === 'agent');
  assert.equal(agentCorrs.length, 2);
  const claude = agentCorrs.find((c) => c.agentType === 'claude-code');
  assert.ok(claude);
  assert.equal(claude!.incidentCount, 2);
  assert.equal(claude!.affectedExecutions, 2);
  assert.ok(claude!.affectedAgents.includes('claude-code'));
});

test('buildCorrelations: kind dimension correlates by kind', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
    incident({ executionId: 'e3', kind: 'level-regression' }),
  ];
  const map = new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'codex'],
    ['e3', 'claude-code'],
  ]);
  const out = buildCorrelations(incidents, map);
  const kindCorrs = out.filter((c) => c.dimension === 'kind');
  assert.equal(kindCorrs.length, 2);
  const score = kindCorrs.find((c) => c.kind === 'score-drop');
  assert.ok(score);
  assert.equal(score!.incidentCount, 2);
  assert.equal(score!.affectedAgents.length, 2);
});

test('buildCorrelations: agent-kind dimension correlates both axes', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
    incident({ executionId: 'e3', kind: 'level-regression' }),
  ];
  const map = new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'codex'],
    ['e3', 'claude-code'],
  ]);
  const out = buildCorrelations(incidents, map);
  const akCorrs = out.filter((c) => c.dimension === 'agent-kind');
  // claude-code/score-drop, codex/score-drop, claude-code/level-regression
  assert.equal(akCorrs.length, 3);
});

test('buildCorrelations: degradationFrequency is incidents per execution', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e1', kind: 'level-regression' }),
    incident({ executionId: 'e1', kind: 'rapid-degradation' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code']]);
  const out = buildCorrelations(incidents, map);
  const claude = out.find((c) => c.dimension === 'agent' && c.agentType === 'claude-code');
  assert.ok(claude);
  assert.equal(claude!.incidentCount, 4);
  assert.equal(claude!.affectedExecutions, 2);
  assert.equal(claude!.degradationFrequency, 4 / 2);
});

test('buildCorrelations: status = active when any incident is non-recovered', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop', lifecycle: 'recovered' }),
    incident({ executionId: 'e1', kind: 'level-regression', lifecycle: 'detected' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const out = buildCorrelations(incidents, map);
  const agent = out.find((c) => c.dimension === 'agent');
  assert.equal(agent!.status, 'active');
});

/* ---------------- buildCorrelationSummary ---------------- */

test('buildCorrelationSummary: workspace rollup is correct', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop', lifecycle: 'detected' }),
    incident({ executionId: 'e2', kind: 'level-regression', lifecycle: 'recovered' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code']]);
  const corr = buildCorrelations(incidents, map);
  const summary = buildCorrelationSummary(corr, incidents, map);
  assert.equal(summary.totalActive, 1);
  assert.equal(summary.totalRecovered, 1);
  assert.equal(summary.affectedAgentCount, 1);
  assert.equal(summary.affectedExecutionCount, 2);
  assert.equal(summary.topAgent, 'claude-code');
});

test('buildCorrelationSummary: topKind by incidentCount', () => {
  const incidents = [
    incident({ executionId: 'e1', kind: 'score-drop' }),
    incident({ executionId: 'e2', kind: 'score-drop' }),
    incident({ executionId: 'e3', kind: 'level-regression' }),
  ];
  const map = new Map<string, string>([['e1', 'a'], ['e2', 'b'], ['e3', 'c']]);
  const corr = buildCorrelations(incidents, map);
  const summary = buildCorrelationSummary(corr, incidents, map);
  assert.equal(summary.topKind, 'score-drop');
});

/* ---------------- buildExecutionToAgentMap ---------------- */

test('buildExecutionToAgentMap: extracts AgentType from session.agent_id', () => {
  const map = buildExecutionToAgentMap([
    { id: 's1', agent_id: 'claude-code:ext-1' },
    { id: 's2', agent_id: 'codex:external-uuid' },
    { id: 's3', agent_id: 'grok' }, // no colon
  ]);
  assert.equal(map.get('s1'), 'claude-code');
  assert.equal(map.get('s2'), 'codex');
  assert.equal(map.get('s3'), 'grok');
});

test('buildExecutionToAgentMap: empty input → empty map', () => {
  assert.equal(buildExecutionToAgentMap([]).size, 0);
});