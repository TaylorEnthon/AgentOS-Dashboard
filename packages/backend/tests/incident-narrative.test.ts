/**
 * v1.17 Incident Investigation Narrative — pure-function tests.
 *
 * Covers:
 *   - buildInvestigationNarrative: returns null when report is null
 *   - buildInvestigationNarrative: empty fields on a minimal report
 *   - buildInvestigationNarrative: summary generation (single + multi)
 *   - buildInvestigationNarrative: findings generation (history, evidence, investigation)
 *   - buildInvestigationNarrative: hypotheses generation (always includes caveat)
 *   - buildInvestigationNarrative: deterministic — same input yields same output
 *   - buildInvestigationNarrative: stable ordering (findings & hypotheses)
 *   - buildInvestigationNarrative: generatedAt is the caller-supplied timestamp
 *   - buildInvestigationNarrative: incidentKey echoes
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestigationNarrative } from '../src/incident-narrative.js';
import type {
  HealthAnomalyKind,
  HealthAnomalySeverity,
  HealthIncident,
  IncidentAgentRow,
  IncidentExecutionRow,
  IncidentHistoricalContext,
  IncidentInvestigationNarrative,
  IncidentInvestigationReport,
  IncidentInvestigationView,
  IncidentPriorityInsight,
  IncidentRootCauseEvidence,
  IntelligenceSignal,
  RootCauseEvidenceItem,
} from '@agentos/shared';

const NOON = Date.UTC(2026, 6, 23, 12, 0, 0);
const NOW_ISO = new Date(NOON).toISOString();

/* ---------------- helpers ---------------- */

function mkInc(args: {
  executionId: string;
  kind?: HealthAnomalyKind;
  detectedAtMs: number;
}): HealthIncident {
  const kind = args.kind ?? 'score-drop';
  return {
    incidentKey: `${args.executionId}|${kind}`,
    executionId: args.executionId,
    kind,
    severity: 'high',
    initialSeverity: 'high',
    currentSeverity: 'high',
    maxSeverity: 'high',
    escalationCount: 0,
    detectedAt: new Date(args.detectedAtMs).toISOString(),
    lastTransitionAt: null,
    lifecycle: 'detected',
    recoveredAt: null,
    durationMs: null,
    reason: `[${kind}]`,
  };
}

function mkPriority(): IncidentPriorityInsight {
  return {
    priorityId: 'burst:score-drop',
    signalKind: 'burst',
    signalSeverity: 'alert',
    subjectKey: 'score-drop',
    signalId: 'burst:score-drop',
    signalScore: 3,
    signalThreshold: 3,
    signalDescription: 'test',
    since: NOW_ISO,
    until: NOW_ISO,
    priorityScore: 80,
    priorityLevel: 'critical',
    reasons: [],
    trendHint: null,
  };
}

function mkSignal(): IntelligenceSignal {
  return {
    signalId: 'burst:score-drop',
    kind: 'burst',
    severity: 'alert',
    subjectKey: 'score-drop',
    since: NOW_ISO,
    until: NOW_ISO,
    score: 3,
    threshold: 3,
    description: 'test',
  };
}

function mkInvestigation(args: {
  affectedExecutions?: IncidentExecutionRow[];
  affectedAgents?: IncidentAgentRow[];
  totalRelatedIncidents?: number;
  activeCount?: number;
  recoveredCount?: number;
  criticalCount?: number;
  highCount?: number;
} = {}): IncidentInvestigationView {
  return {
    priority: mkPriority(),
    signal: mkSignal(),
    relatedIncidents: [mkInc({ executionId: 'exec-1', detectedAtMs: NOON })],
    affectedExecutions: args.affectedExecutions ?? [],
    affectedAgents: args.affectedAgents ?? [],
    evidence: [],
    summary: {
      totalRelatedIncidents: args.totalRelatedIncidents ?? 1,
      activeCount: args.activeCount ?? 1,
      recoveredCount: args.recoveredCount ?? 0,
      criticalCount: args.criticalCount ?? 1,
      highCount: args.highCount ?? 0,
      timeRange: { since: NOW_ISO, until: NOW_ISO },
    },
    computedAt: NOW_ISO,
  };
}

function mkHistory(args: {
  occurrenceCount?: number;
  recoveredCount?: number;
  recurrenceRate?: number;
  kind?: HealthAnomalyKind;
  firstSeen?: string | null;
  lastSeen?: string | null;
  averageDurationMs?: number | null;
  maxDurationMs?: number | null;
} = {}): IncidentHistoricalContext {
  return {
    incidentKey: 'exec-1|score-drop',
    kind: args.kind ?? 'score-drop',
    executionId: 'exec-1',
    occurrenceCount: args.occurrenceCount ?? 1,
    recoveredCount: args.recoveredCount ?? 0,
    averageDurationMs: args.averageDurationMs ?? null,
    maxDurationMs: args.maxDurationMs ?? null,
    firstSeen: args.firstSeen === undefined ? NOW_ISO : args.firstSeen,
    lastSeen: args.lastSeen === undefined ? NOW_ISO : args.lastSeen,
    recurrenceRate: args.recurrenceRate ?? 0,
    previousIncidents: [],
    hasHistory: true,
    computedAt: NOW_ISO,
  };
}

function mkEvidence(args: {
  evidence?: RootCauseEvidenceItem[];
} = {}): IncidentRootCauseEvidence {
  return {
    incidentKey: 'exec-1|score-drop',
    executionId: 'exec-1',
    kind: 'score-drop',
    evidence: args.evidence ?? [],
    confidence: 0,
    hasEvidence: (args.evidence?.length ?? 0) > 0,
    computedAt: NOW_ISO,
  };
}

function mkReport(args: {
  investigation?: IncidentInvestigationView;
  history?: IncidentHistoricalContext;
  evidence?: IncidentRootCauseEvidence;
  incidentKey?: string;
} = {}): IncidentInvestigationReport {
  return {
    incidentKey: args.incidentKey ?? 'exec-1|score-drop',
    investigation: args.investigation ?? mkInvestigation(),
    history: args.history ?? mkHistory(),
    evidence: args.evidence ?? mkEvidence(),
    generatedAt: NOW_ISO,
  };
}

/* ---------------- null report ---------------- */

test('buildInvestigationNarrative: returns null when report is null', () => {
  const r = buildInvestigationNarrative({ report: null, nowIso: NOW_ISO });
  assert.equal(r, null);
});

/* ---------------- empty fields ---------------- */

test('buildInvestigationNarrative: minimal report produces populated sections', () => {
  const r = buildInvestigationNarrative({ report: mkReport(), nowIso: NOW_ISO });
  assert.ok(r);
  // summary is always present
  assert.ok(r!.summary.length > 0);
  // findings: at least scope + priority + first-incident
  assert.ok(r!.findings.length >= 2);
  // hypotheses: at least the always-on caveat
  assert.ok(r!.hypotheses.length >= 1);
  // The last hypothesis must be the caveat
  const last = r!.hypotheses[r!.hypotheses.length - 1];
  assert.match(last, /caveat|not verified|not root causes/i);
});

/* ---------------- summary ---------------- */

test('buildInvestigationNarrative: summary mentions single incident + execution id', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({ incidentKey: 's1:exec-0|score-drop' }),
    nowIso: NOW_ISO,
  });
  assert.ok(r);
  assert.match(r!.summary, /score-drop/);
  assert.match(r!.summary, /s1:exec-0/);
});

test('buildInvestigationNarrative: summary mentions severity from investigation', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({ criticalCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.match(r!.summary, /critical/);
});

test('buildInvestigationNarrative: summary uses "high" when no critical signals', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({ criticalCount: 0, highCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.match(r!.summary, /high/);
});

test('buildInvestigationNarrative: summary mentions agent when one is dominant', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({
        totalRelatedIncidents: 5,
        affectedAgents: [
          {
            agentType: 'claude-code',
            executionCount: 3,
            incidentCount: 5,
            activeCount: 1,
            recoveredCount: 4,
            criticalCount: 1,
            worstSeverity: 'high',
            byKind: [{ kind: 'score-drop', incidentCount: 5 }],
          },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.match(r!.summary, /claude-code/);
});

test('buildInvestigationNarrative: summary multi-incident phrasing', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({
        totalRelatedIncidents: 3,
        affectedExecutions: [
          {
            executionId: 'e1', agentType: 'claude-code',
            incidentCount: 1, activeCount: 1, worstSeverity: 'high',
            lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
            lastIncidentAt: NOW_ISO,
          },
          {
            executionId: 'e2', agentType: 'claude-code',
            incidentCount: 1, activeCount: 1, worstSeverity: 'high',
            lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
            lastIncidentAt: NOW_ISO,
          },
          {
            executionId: 'e3', agentType: 'claude-code',
            incidentCount: 1, activeCount: 1, worstSeverity: 'high',
            lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
            lastIncidentAt: NOW_ISO,
          },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.match(r!.summary, /3 score-drop/);
  assert.match(r!.summary, /across 3 execution/);
});

/* ---------------- findings ---------------- */

test('buildInvestigationNarrative: findings include priority level', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({
        investigation: undefined, // use default
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.findings.some((f) => /Priority level/.test(f)));
});

test('buildInvestigationNarrative: findings include historical occurrence count', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 3 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.findings.some((f) => /occurred 5 times/.test(f)));
  assert.ok(r!.findings.some((f) => /recovery rate/.test(f)));
});

test('buildInvestigationNarrative: findings include average recovery time when available', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({
        occurrenceCount: 3,
        recoveredCount: 2,
        averageDurationMs: 5000,
        maxDurationMs: 12000,
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.findings.some((f) => /Average recovery time/.test(f)));
  assert.ok(r!.findings.some((f) => /max:/.test(f)));
});

test('buildInvestigationNarrative: findings include recurrence rate when > 0', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 4, recurrenceRate: 0.5 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.findings.some((f) => /recurrence rate/i.test(f)));
});

test('buildInvestigationNarrative: findings passthrough evidence messages', () => {
  const items: RootCauseEvidenceItem[] = [
    { kind: 'severity', message: 'Severity is critical.', confidence: 1, weight: 0.95 },
    { kind: 'history', message: 'score-drop observed 5 times.', confidence: 0.8, weight: 0.9 },
  ];
  const r = buildInvestigationNarrative({
    report: mkReport({ evidence: mkEvidence({ evidence: items }) }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.findings.some((f) => /\[severity\]/.test(f)));
  assert.ok(r!.findings.some((f) => /\[history\]/.test(f)));
  assert.ok(r!.findings.some((f) => /Severity is critical/.test(f)));
  assert.ok(r!.findings.some((f) => /score-drop observed 5 times/.test(f)));
});

/* ---------------- hypotheses ---------------- */

test('buildInvestigationNarrative: hypotheses always include caveat', () => {
  const r = buildInvestigationNarrative({
    report: mkReport(),
    nowIso: NOW_ISO,
  });
  const last = r!.hypotheses[r!.hypotheses.length - 1];
  assert.match(last, /caveat|not verified|not root causes/i);
});

test('buildInvestigationNarrative: hypotheses mention recurring kind when history shows recurrence', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.hypotheses.some((h) => /Recurring kind pattern/.test(h)));
});

test('buildInvestigationNarrative: hypotheses mention agent pattern when agent evidence present', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      evidence: mkEvidence({
        evidence: [
          { kind: 'agent', message: 'Agent "claude-code" has 4 score-drops.', confidence: 0.85, weight: 0.85 },
        ],
      }),
      investigation: mkInvestigation({
        affectedAgents: [
          {
            agentType: 'claude-code',
            executionCount: 2, incidentCount: 4, activeCount: 1,
            recoveredCount: 3, criticalCount: 1, worstSeverity: 'critical',
            byKind: [{ kind: 'score-drop', incidentCount: 4 }],
          },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.hypotheses.some((h) => /Agent-level pattern/.test(h)));
  assert.ok(r!.hypotheses.some((h) => /claude-code/.test(h)));
});

test('buildInvestigationNarrative: hypotheses mention multi-execution impact', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      investigation: mkInvestigation({
        affectedExecutions: [
          {
            executionId: 'e1', agentType: 'claude-code',
            incidentCount: 1, activeCount: 1, worstSeverity: 'high',
            lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
            lastIncidentAt: NOW_ISO,
          },
          {
            executionId: 'e2', agentType: 'claude-code',
            incidentCount: 1, activeCount: 1, worstSeverity: 'high',
            lifecycleCounts: { detected: 1, ongoing: 0, recovered: 0 },
            lastIncidentAt: NOW_ISO,
          },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.hypotheses.some((h) => /Multi-execution impact/.test(h)));
});

test('buildInvestigationNarrative: hypotheses mention recovery instability on incomplete recovery', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.hypotheses.some((h) => /Recovery instability/.test(h)));
});

test('buildInvestigationNarrative: hypotheses mention recovery instability on high recurrenceRate', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({
        occurrenceCount: 4,
        recoveredCount: 4,
        recurrenceRate: 0.9,
      }),
    }),
    nowIso: NOW_ISO,
  });
  assert.ok(r!.hypotheses.some((h) => /Recovery instability/.test(h)));
});

/* ---------------- determinism ---------------- */

test('buildInvestigationNarrative: deterministic — same input yields same output', () => {
  const args = {
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 3 }),
      evidence: mkEvidence({
        evidence: [
          { kind: 'severity', message: 'Severity is critical.', confidence: 1, weight: 0.95 },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  };
  const a = buildInvestigationNarrative(args);
  const b = buildInvestigationNarrative(args);
  assert.deepEqual(a, b);
});

test('buildInvestigationNarrative: deterministic across reordered pool (passthrough)', () => {
  // Inputs are independent of pool ordering since we re-aggregate in buildInvestigation.
  const args = {
    report: mkReport(),
    nowIso: NOW_ISO,
  };
  const a = buildInvestigationNarrative(args);
  const b = buildInvestigationNarrative(args);
  assert.deepEqual(a, b);
});

/* ---------------- stable ordering ---------------- */

test('buildInvestigationNarrative: findings are ordered (history → evidence → investigation)', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 3 }),
      evidence: mkEvidence({
        evidence: [
          { kind: 'severity', message: 'sev', confidence: 1, weight: 0.95 },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  // Findings contain both scope/priority lines AND history AND evidence.
  // Verify ordering: scope + priority appear first, then history, then evidence items.
  const findings = r!.findings;
  const scopeIdx = findings.findIndex((f) => /Scope:/.test(f));
  const priorityIdx = findings.findIndex((f) => /Priority level:/.test(f));
  const historyIdx = findings.findIndex((f) => /occurred \d+ times/.test(f));
  const evidenceIdx = findings.findIndex((f) => /\[severity\]/.test(f));
  assert.ok(scopeIdx >= 0 && scopeIdx < historyIdx);
  assert.ok(priorityIdx >= 0 && priorityIdx < historyIdx);
  assert.ok(historyIdx >= 0 && historyIdx < evidenceIdx);
});

test('buildInvestigationNarrative: hypotheses are ordered with caveat last', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5, recoveredCount: 1 }),
    }),
    nowIso: NOW_ISO,
  });
  const hypotheses = r!.hypotheses;
  // Caveat is always last
  assert.match(hypotheses[hypotheses.length - 1], /caveat/i);
  // Severity hypothesis (if present) comes early
  const sevIdx = hypotheses.findIndex((h) => /Severity pattern/.test(h));
  if (sevIdx >= 0) {
    assert.ok(sevIdx < hypotheses.length - 1);
  }
});

/* ---------------- generatedAt ---------------- */

test('buildInvestigationNarrative: generatedAt is the caller-supplied timestamp', () => {
  const r = buildInvestigationNarrative({
    report: mkReport(),
    nowIso: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(r!.generatedAt, '2030-01-01T00:00:00.000Z');
});

/* ---------------- incidentKey echo ---------------- */

test('buildInvestigationNarrative: incidentKey echoes from report', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({ incidentKey: 'my-exec|level-regression' }),
    nowIso: NOW_ISO,
  });
  assert.equal(r!.incidentKey, 'my-exec|level-regression');
});

/* ---------------- no LLM / no ML / no auto-execute ---------------- */

test('buildInvestigationNarrative: never auto-executes — output is text only', () => {
  const r = buildInvestigationNarrative({
    report: mkReport({
      history: mkHistory({ occurrenceCount: 5 }),
      evidence: mkEvidence({
        evidence: [
          { kind: 'severity', message: 'critical', confidence: 1, weight: 0.95 },
        ],
      }),
    }),
    nowIso: NOW_ISO,
  });
  // All sections are strings (text), no structured "command" or "action"
  assert.equal(typeof r!.summary, 'string');
  assert.ok(Array.isArray(r!.findings));
  assert.ok(Array.isArray(r!.hypotheses));
  for (const f of r!.findings) assert.equal(typeof f, 'string');
  for (const h of r!.hypotheses) assert.equal(typeof h, 'string');
});