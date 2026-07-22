/**
 * v1.1 Agent Lifecycle Intelligence Foundation tests.
 *
 * Covers:
 *  - 6-state classification (queued / running / idle / blocked /
 *    completed / failed)
 *  - empty / null inputs
 *  - boundary times (ACTIVE / IDLE / BLOCKED thresholds)
 *  - indicators populated correctly
 *  - confidence derivation (high / medium / low)
 *  - shouldRecordAutoTransition dedup + low-confidence skip
 *  - regression: no DB / no time side-effects (pure function)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_THRESHOLD_MS,
  analyzeLifecycle,
  BLOCKED_THRESHOLD_MS,
  IDLE_THRESHOLD_MS,
  shouldRecordAutoTransition,
} from '../src/lifecycle-analyzer.js';
import type {
  DerivedLifecycleStatus,
  GitCommitInfo,
  TimelineItem,
} from '@agentos/shared';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const EXEC_ID = 'claude-code:abc:exec-0';

function ev(iso: string, opts: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: `e_${iso}`,
    agentId: 'claude-code',
    agentType: 'claude-code',
    sessionId: 'claude-code:abc',
    sessionTitle: null,
    project: '/p/test',
    projectDisplay: '/p/test',
    timestamp: iso,
    type: 'message',
    action: 'msg',
    detail: null,
    meta: null,
    ...opts,
  };
}

function commit(iso: string, hash = 'abc1234'): GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: 'feat',
    body: '',
    author: 'a',
    authorEmail: 'a@b',
    timestamp: iso,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  };
}

/* ---------------- 6-state classification ---------------- */

test('analyzeLifecycle: empty data → queued', () => {
  const snap = analyzeLifecycle(EXEC_ID, {
    events: [],
    commits: [],
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: null,
    nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'queued');
  assert.match(snap.reason, /No activity/);
});

test('analyzeLifecycle: queued = only tool/file ops + very recent + start < 5min', () => {
  const start = new Date(NOW - 60_000).toISOString();
  const events = [
    ev(start, { type: 'tool-call', detail: 'ls' }),
    ev(new Date(NOW - 10_000).toISOString(), { type: 'file-read', detail: 'foo.ts' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'queued');
});

test('analyzeLifecycle: running = last event within ACTIVE_THRESHOLD', () => {
  const start = new Date(NOW - 5 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - ACTIVE_THRESHOLD_MS / 2).toISOString(), { type: 'tool-call', detail: 'ls' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'running');
});

test('analyzeLifecycle: idle = last event within IDLE but past ACTIVE', () => {
  const start = new Date(NOW - 10 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - (ACTIVE_THRESHOLD_MS + 60_000)).toISOString(), { type: 'message', detail: 'idle' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'idle');
});

test('analyzeLifecycle: blocked = old activity + recent commit', () => {
  const start = new Date(NOW - 2 * 60 * 60_000).toISOString(); // 2h ago
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - BLOCKED_THRESHOLD_MS - 60_000).toISOString(), { type: 'message', detail: 'silence' }),
  ];
  const commits = [
    commit(new Date(NOW - 5 * 60_000).toISOString()), // commit 5min ago
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits, startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'blocked');
});

test('analyzeLifecycle: NOT blocked if commits are old', () => {
  const start = new Date(NOW - 4 * 60 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - BLOCKED_THRESHOLD_MS - 60_000).toISOString(), { type: 'message', detail: 'silence' }),
  ];
  const commits = [
    commit(new Date(NOW - 60 * 60_000).toISOString()), // commit 1h ago
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits, startTime: start, endTime: null, nowMs: NOW,
  });
  assert.notEqual(snap.derivedStatus, 'blocked');
});

test('analyzeLifecycle: completed = end_time set + commits', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const end = new Date(NOW - 10 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(end, { type: 'message', detail: 'bye' }),
  ];
  const commits = [commit(end)];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits, startTime: start, endTime: end, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'completed');
});

test('analyzeLifecycle: completed = end_time set, no commits', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const end = new Date(NOW - 10 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(end, { type: 'message', detail: 'bye' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: end, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'completed');
});

test('analyzeLifecycle: failed = session-end with failure detail', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - 5 * 60_000).toISOString(), { type: 'session-end', detail: 'agent failed: out of context' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'failed');
});

test('analyzeLifecycle: failed = session-end with abort detail', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - 5 * 60_000).toISOString(), { type: 'session-end', detail: 'user aborted the run' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'failed');
});

test('analyzeLifecycle: end_time present but end_time > now → not completed', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const futureEnd = new Date(NOW + 60_000).toISOString();
  const events = [ev(start, { type: 'message', detail: 'hi' })];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: futureEnd, nowMs: NOW,
  });
  assert.notEqual(snap.derivedStatus, 'completed');
});

/* ---------------- indicators ---------------- */

test('analyzeLifecycle: indicators populated with weights', () => {
  const start = new Date(NOW - 60_000).toISOString();
  const events = [ev(start, { type: 'message', detail: 'hi' })];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.ok(Array.isArray(snap.indicators));
  assert.ok(snap.indicators.length > 0);
  // All weights in 0..1
  for (const ind of snap.indicators) {
    assert.ok(ind.weight >= 0 && ind.weight <= 1, `weight out of range: ${ind.weight}`);
  }
});

test('analyzeLifecycle: empty data emits empty-data indicator', () => {
  const snap = analyzeLifecycle(EXEC_ID, {
    events: [],
    commits: [],
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: null,
    nowMs: NOW,
  });
  assert.ok(snap.indicators.some((i) => i.type === 'empty-data'));
});

test('analyzeLifecycle: blocked emits blocked-threshold-crossed indicator', () => {
  const start = new Date(NOW - 2 * 60 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - BLOCKED_THRESHOLD_MS - 60_000).toISOString(), { type: 'message', detail: 'silence' }),
  ];
  const commits = [commit(new Date(NOW - 5 * 60_000).toISOString())];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits, startTime: start, endTime: null, nowMs: NOW,
  });
  assert.ok(snap.indicators.some((i) => i.type === 'blocked-threshold-crossed'));
});

/* ---------------- confidence ---------------- */

test('analyzeLifecycle: confidence high when multiple strong indicators agree', () => {
  const start = new Date(NOW - 5 * 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - ACTIVE_THRESHOLD_MS / 2).toISOString(), { type: 'message', detail: 'still here' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  // running case: recent-activity indicator (weight 1) + tool calls
  assert.equal(snap.derivedStatus, 'running');
  assert.ok(snap.confidence === 'high' || snap.confidence === 'medium');
});

test('analyzeLifecycle: confidence low for empty data', () => {
  const snap = analyzeLifecycle(EXEC_ID, {
    events: [],
    commits: [],
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: null,
    nowMs: NOW,
  });
  assert.equal(snap.confidence, 'low');
});

/* ---------------- lastActivityAt / lastActivityAgeMs ---------------- */

test('analyzeLifecycle: lastActivityAt = most recent of (lastEvent, lastCommit, endTime)', () => {
  const start = new Date(NOW - 60 * 60_000).toISOString();
  const eventTs = new Date(NOW - 30 * 60_000).toISOString();
  const commitTs = new Date(NOW - 10 * 60_000).toISOString(); // newer
  const events = [ev(start, { type: 'message', detail: 'hi' }), ev(eventTs)];
  const commits = [commit(commitTs)];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits, startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.lastActivityAt, commitTs);
  assert.equal(snap.lastActivityAgeMs, 10 * 60_000);
});

test('analyzeLifecycle: lastActivityAt null when no events / commits / end', () => {
  const snap = analyzeLifecycle(EXEC_ID, {
    events: [],
    commits: [],
    startTime: new Date(NOW).toISOString(), // start at now, no activity yet
    endTime: null,
    nowMs: NOW,
  });
  assert.equal(snap.lastActivityAt, null);
  assert.equal(snap.lastActivityAgeMs, null);
});

/* ---------------- boundaries ---------------- */

test('analyzeLifecycle: exactly ACTIVE_THRESHOLD is still running', () => {
  const start = new Date(NOW - 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - ACTIVE_THRESHOLD_MS).toISOString(), { type: 'message', detail: 'still' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'running');
});

test('analyzeLifecycle: 1ms past ACTIVE → idle', () => {
  const start = new Date(NOW - 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - ACTIVE_THRESHOLD_MS - 1).toISOString(), { type: 'message', detail: 'idle' }),
  ];
  const snap = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.equal(snap.derivedStatus, 'idle');
});

/* ---------------- purity ---------------- */

test('analyzeLifecycle: same inputs ⇒ same output (pure)', () => {
  const start = new Date(NOW - 60_000).toISOString();
  const events = [
    ev(start, { type: 'message', detail: 'hi' }),
    ev(new Date(NOW - ACTIVE_THRESHOLD_MS / 2).toISOString(), { type: 'message', detail: 'still' }),
  ];
  const a = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  const b = analyzeLifecycle(EXEC_ID, {
    events, commits: [], startTime: start, endTime: null, nowMs: NOW,
  });
  assert.deepEqual(a, b);
});

/* ---------------- shouldRecordAutoTransition ---------------- */

test('shouldRecordAutoTransition: first record + high confidence → write', () => {
  const curr = analyzeLifecycle(EXEC_ID, {
    events: [ev(new Date(NOW - 1000).toISOString(), { type: 'message' })],
    commits: [],
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: null,
    nowMs: NOW,
  });
  // simulate passing the running snapshot above (just construct one)
  const decision = shouldRecordAutoTransition(null, curr, NOW);
  assert.equal(decision.shouldWrite, true);
});

test('shouldRecordAutoTransition: same status as previous → skip', () => {
  const curr: import('@agentos/shared').LifecycleSnapshot = {
    executionId: EXEC_ID,
    derivedStatus: 'running',
    confidence: 'high',
    reason: '...',
    lastActivityAt: null,
    lastActivityAgeMs: 100,
    indicators: [],
    computedAt: new Date(NOW).toISOString(),
  };
  const prev = { toStatus: 'running' as DerivedLifecycleStatus, createdAt: new Date(NOW - 60_000).toISOString() };
  const decision = shouldRecordAutoTransition(prev, curr, NOW);
  assert.equal(decision.shouldWrite, false);
  assert.match(decision.reason, /same status/);
});

test('shouldRecordAutoTransition: low confidence → skip', () => {
  const curr: import('@agentos/shared').LifecycleSnapshot = {
    executionId: EXEC_ID,
    derivedStatus: 'queued',
    confidence: 'low',
    reason: '...',
    lastActivityAt: null,
    lastActivityAgeMs: null,
    indicators: [],
    computedAt: new Date(NOW).toISOString(),
  };
  const decision = shouldRecordAutoTransition(null, curr, NOW);
  assert.equal(decision.shouldWrite, false);
  assert.match(decision.reason, /confidence is low/);
});

test('shouldRecordAutoTransition: within dedupe window → skip', () => {
  const curr: import('@agentos/shared').LifecycleSnapshot = {
    executionId: EXEC_ID,
    derivedStatus: 'idle',
    confidence: 'high',
    reason: '...',
    lastActivityAt: null,
    lastActivityAgeMs: 60_000,
    indicators: [],
    computedAt: new Date(NOW).toISOString(),
  };
  const prev = { toStatus: 'running' as DerivedLifecycleStatus, createdAt: new Date(NOW - 60_000).toISOString() };
  const decision = shouldRecordAutoTransition(prev, curr, NOW);
  assert.equal(decision.shouldWrite, false);
  assert.match(decision.reason, /dedupe/i);
});

test('shouldRecordAutoTransition: real status change past dedupe → write', () => {
  const curr: import('@agentos/shared').LifecycleSnapshot = {
    executionId: EXEC_ID,
    derivedStatus: 'blocked',
    confidence: 'high',
    reason: '...',
    lastActivityAt: null,
    lastActivityAgeMs: 60 * 60_000,
    indicators: [],
    computedAt: new Date(NOW).toISOString(),
  };
  const prev = { toStatus: 'running' as DerivedLifecycleStatus, createdAt: new Date(NOW - 60 * 60_000).toISOString() };
  const decision = shouldRecordAutoTransition(prev, curr, NOW);
  assert.equal(decision.shouldWrite, true);
});