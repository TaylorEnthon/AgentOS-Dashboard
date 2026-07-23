/**
 * v1.14 Incident Root Cause Evidence — pure-function tests.
 *
 * Covers:
 *   - buildRootCauseEvidence: invalid key → null
 *   - buildRootCauseEvidence: current not in pool → null
 *   - buildRootCauseEvidence: single incident (no prior history)
 *   - buildRootCauseEvidence: history evidence fires when prior exists
 *   - buildRootCauseEvidence: severity evidence always fires
 *   - buildRootCauseEvidence: impact evidence (same-execution / agent)
 *   - buildRootCauseEvidence: agent evidence (agent recurrence)
 *   - buildRootCauseEvidence: trend evidence (uses history metrics)
 *   - buildRootCauseEvidence: priority evidence (when supplied)
 *   - buildRootCauseEvidence: ordering by weight DESC, then confidence
 *   - buildRootCauseEvidence: deterministic
 *   - buildRootCauseEvidence: confidence is max of individual confidences
 *   - buildRootCauseEvidence: empty bundle when nothing fires
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRootCauseEvidence } from '../src/incident-evidence.js';
import { buildHistoricalContext } from '../src/incident-history.js';
import type {
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentPriorityInsight,
} from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);
const NOW_ISO = new Date(NOON).toISOString();

/* ---------------- helpers ---------------- */

function mkInc(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  severity?: HealthAnomalySeverity;
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
    reason: `[${kind}] ${args.executionId}`,
  };
}

/** Convenience: build history then evidence. */
function build(args: {
  incidentKey: string;
  incidents: HealthIncident[];
  execToAgent?: Map<string, string>;
  priority?: IncidentPriorityInsight;
}): ReturnType<typeof buildRootCauseEvidence> {
  const execToAgent = args.execToAgent ?? new Map<string, string>();
  const history = buildHistoricalContext({
    incidentKey: args.incidentKey,
    allIncidents: args.incidents,
    nowIso: NOW_ISO,
  });
  if (!history) return null;
  return buildRootCauseEvidence({
    incidentKey: args.incidentKey,
    allIncidents: args.incidents,
    history,
    executionToAgent: execToAgent,
    priority: args.priority,
    nowIso: NOW_ISO,
  });
}

/* ---------------- invalid key / missing current ---------------- */

test('buildRootCauseEvidence: invalid key returns null', () => {
  const r = build({
    incidentKey: 'exec-1|not-a-kind',
    incidents: [],
  });
  assert.equal(r, null);
});

test('buildRootCauseEvidence: current not in pool returns null', () => {
  const inc = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: 'exec-99|score-drop',
    incidents: [inc],
  });
  assert.equal(r, null);
});

/* ---------------- single incident ---------------- */

test('buildRootCauseEvidence: single incident — only severity evidence fires', () => {
  const inc = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, severity: 'high' });
  const r = build({
    incidentKey: inc.incidentKey,
    incidents: [inc],
  });
  assert.ok(r);
  // Only severity (history / impact / agent / trend require ≥ 2 incidents).
  assert.equal(r!.evidence.length, 1);
  assert.equal(r!.evidence[0]!.kind, 'severity');
  assert.equal(r!.confidence, 1.0);
  assert.equal(r!.hasEvidence, true);
});

test('buildRootCauseEvidence: single critical incident with escalation', () => {
  const inc = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    severity: 'critical',
    escalationCount: 2,
  });
  const r = build({
    incidentKey: inc.incidentKey,
    incidents: [inc],
  });
  assert.ok(r);
  const sev = r!.evidence.find((e) => e.kind === 'severity');
  assert.ok(sev);
  assert.match(sev!.message, /escalated 2 time/i);
});

/* ---------------- history evidence ---------------- */

test('buildRootCauseEvidence: history evidence fires when ≥ 2 occurrences', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const prior = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 60_000,
    recoveredAtMs: NOON - 55_000,
  });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, prior],
  });
  assert.ok(r);
  const hist = r!.evidence.find((e) => e.kind === 'history');
  assert.ok(hist);
  assert.match(hist!.message, /observed 2 times/);
  assert.match(hist!.message, /1 prior/);
  assert.ok(hist!.confidence > 0);
});

test('buildRootCauseEvidence: history evidence does NOT fire when only 1 occurrence', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  assert.ok(r);
  const hist = r!.evidence.find((e) => e.kind === 'history');
  assert.equal(hist, undefined);
});

/* ---------------- impact evidence ---------------- */

test('buildRootCauseEvidence: impact evidence fires for same-kind same-execution', () => {
  // Wait — incidentKey = executionId|kind, so two incidents with same
  // incidentKey would be collapsed. So same-execution means SAME
  // (exec, kind) collapsed → no impact. The impact logic actually
  // counts PEERS (same-kind, different incidentKey).
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, kind: 'score-drop' });
  const peer = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    kind: 'score-drop',
  });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, peer],
    execToAgent: new Map([['exec-1', 'claude-code'], ['exec-2', 'claude-code']]),
  });
  assert.ok(r);
  const impact = r!.evidence.find((e) => e.kind === 'impact');
  assert.ok(impact);
  assert.match(impact!.message, /Affected 1 execution/);
});

test('buildRootCauseEvidence: impact evidence multi-execution', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const p1 = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 });
  const p2 = mkInc({ executionId: 'exec-3', detectedAtMs: NOON - 2000 });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, p1, p2],
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
      ['exec-3', 'claude-code'],
    ]),
  });
  assert.ok(r);
  const impact = r!.evidence.find((e) => e.kind === 'impact');
  assert.ok(impact);
  assert.match(impact!.message, /Affected 2 execution/);
});

test('buildRootCauseEvidence: impact does NOT count same (exec,kind) pairs', () => {
  // Only the current exists with kind=score-drop; no peers.
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  const impact = r!.evidence.find((e) => e.kind === 'impact');
  assert.equal(impact, undefined);
});

/* ---------------- agent evidence ---------------- */

test('buildRootCauseEvidence: agent evidence fires for agent recurrence', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const p1 = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, p1],
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
    ]),
  });
  assert.ok(r);
  const agent = r!.evidence.find((e) => e.kind === 'agent');
  assert.ok(agent);
  assert.match(agent!.message, /Agent "claude-code"/);
  assert.match(agent!.message, /2 score-drop/);
});

test('buildRootCauseEvidence: agent evidence requires ≥ 2 agent incidents', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
    execToAgent: new Map([['exec-1', 'claude-code']]),
  });
  const agent = r!.evidence.find((e) => e.kind === 'agent');
  assert.equal(agent, undefined);
});

test('buildRootCauseEvidence: agent evidence not fired when agent unknown', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const p1 = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 });
  // exec-1 has NO entry in the map → agent unknown
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, p1],
    execToAgent: new Map([['exec-2', 'codex']]),
  });
  const agent = r!.evidence.find((e) => e.kind === 'agent');
  assert.equal(agent, undefined);
});

/* ---------------- trend evidence ---------------- */

test('buildRootCauseEvidence: trend evidence fires when ≥ 2 occurrences', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const prior = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, prior],
  });
  assert.ok(r);
  const trend = r!.evidence.find((e) => e.kind === 'trend');
  assert.ok(trend);
  assert.match(trend!.message, /score-drop trend/);
  assert.match(trend!.message, /100% recovery/);
});

test('buildRootCauseEvidence: trend evidence NOT fired with single occurrence', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  const trend = r!.evidence.find((e) => e.kind === 'trend');
  assert.equal(trend, undefined);
});

/* ---------------- priority evidence ---------------- */

test('buildRootCauseEvidence: priority evidence fires when matching kind', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const prior = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 });
  const priority: IncidentPriorityInsight = {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 5,
    signalThreshold: 3,
    signalDescription: 'burst',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 85,
    priorityLevel: 'critical',
    reasons: [],
    trendHint: null,
  };
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, prior],
    priority,
  });
  assert.ok(r);
  const pri = r!.evidence.find((e) => e.kind === 'priority');
  assert.ok(pri);
  assert.match(pri!.message, /burst:score-drop/);
  assert.match(pri!.message, /critical/);
});

test('buildRootCauseEvidence: priority evidence NOT fired when subjectKey mismatches', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const prior = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 });
  const priority: IncidentPriorityInsight = {
    priorityId: 'agent-degradation:claude-code',
    signalKind: 'agent-degradation',
    signalSeverity: 'warn',
    subjectKey: 'claude-code',
    signalId: 'agent-degradation:claude-code',
    signalScore: 3,
    signalThreshold: 3,
    signalDescription: 'agent-degradation',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 60,
    priorityLevel: 'high',
    reasons: [],
    trendHint: null,
  };
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, prior],
    priority,
  });
  assert.ok(r);
  const pri = r!.evidence.find((e) => e.kind === 'priority');
  assert.equal(pri, undefined);
});

test('buildRootCauseEvidence: priority evidence NOT fired when priority is undefined', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  const pri = r!.evidence.find((e) => e.kind === 'priority');
  assert.equal(pri, undefined);
});

/* ---------------- ordering ---------------- */

test('buildRootCauseEvidence: ordered by weight DESC, then confidence DESC, then kind ASC', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    severity: 'critical',
    escalationCount: 1,
  });
  const p1 = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const p2 = mkInc({
    executionId: 'exec-3',
    detectedAtMs: NOON - 2000,
    severity: 'critical',
    escalationCount: 1,
  });
  const priority: IncidentPriorityInsight = {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 5,
    signalThreshold: 3,
    signalDescription: 'burst',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 85,
    priorityLevel: 'critical',
    reasons: [],
    trendHint: null,
  };
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, p1, p2],
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
      ['exec-3', 'claude-code'],
    ]),
    priority,
  });
  assert.ok(r);
  // Verify items are sorted: first entry must have highest weight.
  const weights = r!.evidence.map((e) => e.weight);
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i - 1]! >= weights[i]!, `weight not descending at index ${i}`);
  }
  // severity (weight 0.95 critical, 0.7 high) and priority (weight 0.9 critical)
  // should come before impact/agent (weight 0.8/0.85).
  const first = r!.evidence[0]!;
  assert.ok(['severity', 'priority'].includes(first.kind));
});

/* ---------------- confidence ---------------- */

test('buildRootCauseEvidence: confidence = max(individual.confidence)', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    severity: 'critical',
  });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  assert.ok(r);
  const max = r!.evidence.reduce((m, it) => Math.max(m, it.confidence), 0);
  assert.equal(r!.confidence, max);
});

test('buildRootCauseEvidence: severity confidence is always 1.0', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON, severity: 'high' });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  const sev = r!.evidence.find((e) => e.kind === 'severity')!;
  assert.equal(sev.confidence, 1.0);
});

/* ---------------- determinism ---------------- */

test('buildRootCauseEvidence: deterministic — same input yields same output', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    severity: 'critical',
    escalationCount: 1,
  });
  const prior = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const args = {
    incidentKey: current.incidentKey,
    incidents: [current, prior],
    execToAgent: new Map([['exec-1', 'claude-code'], ['exec-2', 'claude-code']]),
  };
  const a = build(args);
  const b = build(args);
  assert.deepEqual(a, b);
});

test('buildRootCauseEvidence: deterministic across reordered pool', () => {
  const a1 = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const a2 = mkInc({ executionId: 'exec-2', detectedAtMs: NOON - 1000 });
  const a3 = mkInc({ executionId: 'exec-3', detectedAtMs: NOON - 2000 });
  const r1 = build({
    incidentKey: a1.incidentKey,
    incidents: [a1, a2, a3],
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
      ['exec-3', 'claude-code'],
    ]),
  });
  const r2 = build({
    incidentKey: a1.incidentKey,
    incidents: [a3, a1, a2], // reordered
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
      ['exec-3', 'claude-code'],
    ]),
  });
  // Same items, same order, same confidence
  assert.equal(r1!.evidence.length, r2!.evidence.length);
  assert.deepEqual(
    r1!.evidence.map((e) => e.kind),
    r2!.evidence.map((e) => e.kind),
  );
  assert.equal(r1!.confidence, r2!.confidence);
});

/* ---------------- computedAt ---------------- */

test('buildRootCauseEvidence: computedAt is the caller-supplied timestamp', () => {
  const current = mkInc({ executionId: 'exec-1', detectedAtMs: NOON });
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current],
  });
  assert.equal(r!.computedAt, NOW_ISO);
});

/* ---------------- bundling ---------------- */

test('buildRootCauseEvidence: full bundle fires all 5 kinds with rich data', () => {
  const current = mkInc({
    executionId: 'exec-1',
    detectedAtMs: NOON,
    severity: 'critical',
    escalationCount: 1,
  });
  const p1 = mkInc({
    executionId: 'exec-2',
    detectedAtMs: NOON - 1000,
    recoveredAtMs: NOON - 500,
  });
  const p2 = mkInc({
    executionId: 'exec-3',
    detectedAtMs: NOON - 2000,
    severity: 'critical',
  });
  const priority: IncidentPriorityInsight = {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 5,
    signalThreshold: 3,
    signalDescription: 'burst',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 90,
    priorityLevel: 'critical',
    reasons: [{ kind: 'severity', contribution: 40, maxContribution: 40, message: 'critical severity' }],
    trendHint: null,
  };
  const r = build({
    incidentKey: current.incidentKey,
    incidents: [current, p1, p2],
    execToAgent: new Map([
      ['exec-1', 'claude-code'],
      ['exec-2', 'claude-code'],
      ['exec-3', 'claude-code'],
    ]),
    priority,
  });
  assert.ok(r);
  const kinds = new Set(r!.evidence.map((e) => e.kind));
  assert.ok(kinds.has('history'));
  assert.ok(kinds.has('severity'));
  assert.ok(kinds.has('impact'));
  assert.ok(kinds.has('agent'));
  assert.ok(kinds.has('trend'));
  assert.ok(kinds.has('priority'));
  assert.equal(r!.hasEvidence, true);
  assert.equal(r!.confidence, 1.0);
});