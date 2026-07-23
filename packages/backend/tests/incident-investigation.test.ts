/**
 * v1.12 Incident Investigation pure-function tests.
 *
 * Covers:
 *  - buildInvestigation: priority → incident mapping
 *  - related incidents filter (by kind for burst, by agent for
 *    agent-degradation)
 *  - affectedExecutions breakdown (per-execution rollup)
 *  - affectedAgents breakdown (per-agent rollup)
 *  - summary block (active / recovered / critical counts)
 *  - 404-equivalent: unknown priorityId → null
 *  - determinism
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestigation } from '../src/incident-investigation.js';
import { buildPriorities } from '../src/incident-priority.js';
import { detectIntelligenceSignals, summarizeWindow } from '../src/incident-temporal.js';
import type {
  AgentType,
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentPriorityInsight,
  IntelligenceSignal,
  IntelligenceSignalKind,
  IntelligenceSignalSeverity,
} from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);

let incCounter = 0;
function inc(args: {
  executionId: string;
  kind: HealthAnomalyKind;
  minutesAgo: number;
  severity?: HealthAnomalySeverity;
  agentType?: AgentType;
  lifecycle?: 'detected' | 'ongoing' | 'recovered';
}): HealthIncident {
  incCounter += 1;
  return {
    incidentKey: `${args.executionId}|${args.kind}`,
    executionId: args.executionId,
    kind: args.kind,
    severity: args.severity ?? 'high',
    initialSeverity: 'high',
    currentSeverity: args.lifecycle === 'recovered' ? 'low' : (args.severity ?? 'high'),
    maxSeverity: args.severity ?? 'high',
    escalationCount: 0,
    detectedAt: new Date(NOON - args.minutesAgo * 60_000).toISOString(),
    lastTransitionAt: null,
    lifecycle: args.lifecycle ?? 'detected',
    recoveredAt: args.lifecycle === 'recovered' ? new Date(NOON - args.minutesAgo * 60_000 + 60_000).toISOString() : null,
    durationMs: null,
    reason: `[${args.kind}] test`,
  };
}

const NOON_ISO = new Date(NOON).toISOString();
const HOUR_AGO = new Date(NOON - 60 * 60_000).toISOString();

function makePriorities(incidents: HealthIncident[], execToAgent: Map<string, string>): IncidentPriorityInsight[] {
  const summary = summarizeWindow(incidents, execToAgent, { sinceIso: HOUR_AGO, untilIso: NOON_ISO });
  // v1.13 fix: pass nowMs: NOON so detectIntelligenceSignals uses the
  // same pinned clock as the fixtures. Without this, signals depend on
  // wall-clock time and the test fails outside the 1-hour window around
  // NOON UTC.
  const signals = detectIntelligenceSignals(incidents, execToAgent, { nowMs: NOON });
  void summary;
  return buildPriorities({
    signals: signals.signals,
    agentTrends: [],
    windowIncidents: incidents,
    executionToAgent: execToAgent,
    topN: 100,
    sinceIso: HOUR_AGO,
    untilIso: NOON_ISO,
  }).priorities;
}

/* ---------------- 1. priority → incident mapping ---------------- */

test('buildInvestigation: maps priority to its related incidents', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 5,  severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'score-drop',       minutesAgo: 10, severity: 'critical' }),
    inc({ executionId: 'e3', kind: 'score-drop',       minutesAgo: 15, severity: 'high' }),
    inc({ executionId: 'e4', kind: 'level-regression', minutesAgo: 12, severity: 'high' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'codex'], ['e4', 'codex']]);
  const priorities = makePriorities(incidents, map);
  const burstScoreDrop = priorities.find((p) => p.priorityId === 'burst:score-drop');
  assert.ok(burstScoreDrop, 'expected burst:score-drop priority');

  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  // Burst:score-drop should pick up the 3 score-drop incidents only.
  assert.equal(inv!.relatedIncidents.length, 3);
  for (const inc of inv!.relatedIncidents) {
    assert.equal(inc.kind, 'score-drop');
  }
});

test('buildInvestigation: agent-degradation filters by agent, not kind', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 5,  severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'level-regression', minutesAgo: 8,  severity: 'high' }),
    inc({ executionId: 'e3', kind: 'rapid-degradation', minutesAgo: 12, severity: 'high' }),
    inc({ executionId: 'e4', kind: 'score-drop',       minutesAgo: 18, severity: 'high' }),
  ];
  // 3 claude-code execs, 1 codex exec — agent-degradation threshold (3) fires for claude-code.
  const map = new Map<string, string>([
    ['e1', 'claude-code'],
    ['e2', 'claude-code'],
    ['e3', 'claude-code'],
    ['e4', 'codex'],
  ]);
  const priorities = makePriorities(incidents, map);
  const agentDeg = priorities.find((p) => p.priorityId === 'agent-degradation:claude-code');
  assert.ok(agentDeg, 'expected agent-degradation:claude-code priority');

  const inv = buildInvestigation({
    priorityId: 'agent-degradation:claude-code',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  // agent-degradation:claude-code → only incidents whose execution is claude-code.
  // e1, e2, e3 (claude-code); e4 excluded (codex).
  assert.equal(inv!.relatedIncidents.length, 3);
  for (const inc of inv!.relatedIncidents) {
    assert.equal(map.get(inc.executionId), 'claude-code');
  }
});

/* ---------------- 2. affectedExecutions / affectedAgents ---------------- */

test('buildInvestigation: affectedExecutions is per-execution rollup', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 5,  severity: 'critical' }),
    inc({ executionId: 'e1', kind: 'level-regression', minutesAgo: 10, severity: 'high' }),
    inc({ executionId: 'e2', kind: 'score-drop',       minutesAgo: 15, severity: 'high' }),
    inc({ executionId: 'e3', kind: 'score-drop',       minutesAgo: 20, severity: 'high' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'codex'], ['e3', 'claude-code']]);
  const priorities = makePriorities(incidents, map);
  const burst = priorities.find((p) => p.priorityId === 'burst:score-drop');
  assert.ok(burst);

  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  // burst:score-drop picks up score-drop incidents on e1, e2, e3 (3 total).
  const rows = inv!.affectedExecutions;
  assert.equal(rows.length, 3);
  // e1 has 1 score-drop incident; e2 has 1; e3 has 1
  const e1Row = rows.find((r) => r.executionId === 'e1');
  const e2Row = rows.find((r) => r.executionId === 'e2');
  const e3Row = rows.find((r) => r.executionId === 'e3');
  assert.equal(e1Row?.incidentCount, 1);
  assert.equal(e1Row?.agentType, 'claude-code');
  assert.equal(e1Row?.worstSeverity, 'critical');
  assert.equal(e2Row?.incidentCount, 1);
  assert.equal(e2Row?.agentType, 'codex');
  assert.equal(e2Row?.worstSeverity, 'high');
  assert.equal(e3Row?.incidentCount, 1);
  assert.equal(e3Row?.agentType, 'claude-code');
  assert.equal(e3Row?.worstSeverity, 'high');
});

test('buildInvestigation: affectedAgents rollup by agent', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop',       minutesAgo: 5,  severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'score-drop',       minutesAgo: 10, severity: 'high' }),
    inc({ executionId: 'e3', kind: 'level-regression', minutesAgo: 15, severity: 'high' }),
    inc({ executionId: 'e4', kind: 'score-drop',       minutesAgo: 18, severity: 'high' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'codex'], ['e4', 'codex']]);
  const priorities = makePriorities(incidents, map);
  const burst = priorities.find((p) => p.priorityId === 'burst:score-drop');
  assert.ok(burst);

  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  // claude-code has 2 score-drop incidents (e1, e2); codex has 1 score-drop (e4).
  const claudeRow = inv!.affectedAgents.find((r) => r.agentType === 'claude-code');
  const codexRow = inv!.affectedAgents.find((r) => r.agentType === 'codex');
  assert.ok(claudeRow);
  assert.ok(codexRow);
  assert.equal(claudeRow!.incidentCount, 2);
  assert.equal(claudeRow!.executionCount, 2);
  assert.equal(codexRow!.incidentCount, 1);
  assert.equal(codexRow!.executionCount, 1);
});

/* ---------------- 3. summary ---------------- */

test('buildInvestigation: summary counts active / recovered / critical correctly', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5,  severity: 'critical', lifecycle: 'detected' }),
    inc({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10, severity: 'critical', lifecycle: 'ongoing' }),
    inc({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15, severity: 'high',     lifecycle: 'recovered' }),
    inc({ executionId: 'e4', kind: 'score-drop', minutesAgo: 20, severity: 'high',     lifecycle: 'detected' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'claude-code'], ['e4', 'claude-code']]);
  const priorities = makePriorities(incidents, map);
  const burst = priorities.find((p) => p.priorityId === 'burst:score-drop');
  assert.ok(burst);

  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  assert.equal(inv!.summary.totalRelatedIncidents, 4);
  assert.equal(inv!.summary.activeCount, 3);      // e1 + e2 + e4
  assert.equal(inv!.summary.recoveredCount, 1);    // e3
  assert.equal(inv!.summary.criticalCount, 2);
  assert.equal(inv!.summary.highCount, 2);
  assert.equal(inv!.summary.timeRange.since, HOUR_AGO);
  assert.equal(inv!.summary.timeRange.until, NOON_ISO);
});

/* ---------------- 4. unknown priorityId → null ---------------- */

test('buildInvestigation: unknown priorityId returns null', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5, severity: 'critical' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code']]);
  const priorities = makePriorities(incidents, map);
  const inv = buildInvestigation({
    priorityId: 'burst:nonexistent-kind',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.equal(inv, null);
});

test('buildInvestigation: empty priorities list returns null', () => {
  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities: [],
    windowIncidents: [],
    executionToAgent: new Map(),
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.equal(inv, null);
});

/* ---------------- 5. deterministic ---------------- */

test('buildInvestigation: deterministic — same input yields same output', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5,  severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10, severity: 'high' }),
    inc({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15, severity: 'high' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'codex'], ['e3', 'claude-code']]);
  const priorities = makePriorities(incidents, map);
  const a = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
    nowMs: 1,
  });
  const b = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
    nowMs: 1,
  });
  assert.deepEqual(a, b);
  // Different nowMs → different computedAt only
  const c = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
    nowMs: 9_999_999_999,
  });
  assert.equal(c!.computedAt, new Date(9_999_999_999).toISOString());
  // Other fields identical
  assert.equal(c!.priority.priorityId, a!.priority.priorityId);
  assert.equal(c!.summary.totalRelatedIncidents, a!.summary.totalRelatedIncidents);
});

/* ---------------- 6. signal passthrough ---------------- */

test('buildInvestigation: signal in view has correct kind / subject / score / threshold', () => {
  const incidents = [
    inc({ executionId: 'e1', kind: 'score-drop', minutesAgo: 5, severity: 'critical' }),
    inc({ executionId: 'e2', kind: 'score-drop', minutesAgo: 10, severity: 'critical' }),
    inc({ executionId: 'e3', kind: 'score-drop', minutesAgo: 15, severity: 'critical' }),
    inc({ executionId: 'e4', kind: 'score-drop', minutesAgo: 20, severity: 'high' }),
  ];
  const map = new Map<string, string>([['e1', 'claude-code'], ['e2', 'claude-code'], ['e3', 'claude-code'], ['e4', 'codex']]);
  const priorities = makePriorities(incidents, map);
  const burst = priorities.find((p) => p.priorityId === 'burst:score-drop');
  assert.ok(burst);

  const inv = buildInvestigation({
    priorityId: 'burst:score-drop',
    priorities,
    windowIncidents: incidents,
    executionToAgent: map,
    since: HOUR_AGO,
    until: NOON_ISO,
  });
  assert.ok(inv);
  assert.equal(inv!.signal.signalId, burst!.signalId);
  assert.equal(inv!.signal.kind, 'burst');
  assert.equal(inv!.signal.subjectKey, 'score-drop');
  assert.equal(inv!.signal.score, 4);
  assert.equal(inv!.signal.threshold, 3);
});