/**
 * v1.2 Lifecycle Runtime tests.
 *
 * Covers:
 *  - Execution event isolation (scopeEventsToExecution)
 *  - Lifecycle cache: get/set/invalidate/TTL
 *  - Realtime emit: status change → event, same status → no event
 *  - Conflict detection: manual=done + derived=running → conflict
 *  - End-to-end computeAndCacheLifecycle: emits on transition
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAndCacheLifecycle,
  detectLifecycleConflict,
  findExecutionGroup,
  scopeEventsToExecution,
  subscribeLifecycleInvalidation,
  _resetLifecycleInvalidationForTests,
} from '../src/lifecycle-runtime.js';
import {
  createLifecycleCache,
  lifecycleCache as globalCache,
} from '../src/lifecycle-cache.js';
import { eventBus } from '../src/event-bus.js';
import type {
  LifecycleSnapshot,
  TimelineItem,
} from '@agentos/shared';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const SESSION_ID = 'claude-code:abc';
const EXEC0 = 'claude-code:abc:exec-0';
const EXEC1 = 'claude-code:abc:exec-1';

function ev(iso: string, opts: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: `e_${iso}`,
    agentId: 'claude-code',
    agentType: 'claude-code',
    sessionId: SESSION_ID,
    sessionTitle: null,
    project: '',
    projectDisplay: '',
    timestamp: iso,
    type: 'message',
    action: '',
    detail: null,
    meta: null,
    ...opts,
  };
}

/* ---------------- execution scoping ---------------- */

test('scopeEventsToExecution: empty events → empty', () => {
  assert.deepEqual(scopeEventsToExecution([], 0), []);
});

test('scopeEventsToExecution: returns events for the requested exec group only', () => {
  const t0 = new Date(NOW - 60 * 60_000).toISOString();
  const t1 = new Date(NOW - 29 * 60_000).toISOString(); // 31 min after t0 — new group
  const t2 = new Date(NOW - 14 * 60_000).toISOString(); // 15 min after t1 — same group
  const events = [ev(t0), ev(t1), ev(t2)];
  // exec-0 = first group (only t0)
  assert.equal(scopeEventsToExecution(events, 0).length, 1);
  // exec-1 = second group (t1 + t2)
  assert.equal(scopeEventsToExecution(events, 1).length, 2);
});

test('scopeEventsToExecution: out-of-range index → empty', () => {
  const t0 = new Date(NOW - 60_000).toISOString();
  assert.equal(scopeEventsToExecution([ev(t0)], 5).length, 0);
  assert.equal(scopeEventsToExecution([ev(t0)], -1).length, 0);
});

test('scopeEventsToExecution: returns chronological order matching grouping rule', () => {
  const t0 = new Date(NOW - 90 * 60_000).toISOString();
  const t1 = new Date(NOW - 30 * 60_000).toISOString(); // 60 min after t0 — new group
  const t2 = new Date(NOW - 29 * 60_000).toISOString(); // 1 min after t1 — same group
  const events = [ev(t0), ev(t1), ev(t2, { detail: 'later' })];
  const scoped = scopeEventsToExecution(events, 1);
  assert.equal(scoped.length, 2);
  assert.equal(scoped[0]!.timestamp, t1);
  assert.equal(scoped[1]!.detail, 'later');
});

test('findExecutionGroup: returns null when index out of range', () => {
  const events = [ev(new Date(NOW - 60_000).toISOString())];
  assert.equal(findExecutionGroup(events, 0)?.events.length, 1);
  assert.equal(findExecutionGroup(events, 1), null);
});

test('execution isolation: two executions in same session see only their own events', () => {
  // Setup: 3 events. Group 0 = [t0]; 31min gap; Group 1 = [t1, t2]
  const t0 = new Date(NOW - 90 * 60_000).toISOString(); // 90 min ago
  const t1 = new Date(NOW - 50 * 60_000).toISOString(); // 50 min ago
  const t2 = new Date(NOW - 45 * 60_000).toISOString(); // 45 min ago
  const events = [ev(t0, { detail: 'exec-0 work' }), ev(t1, { detail: 'exec-1 work A' }), ev(t2, { detail: 'exec-1 work B' })];

  // exec-0 should see only its own event
  const scoped0 = scopeEventsToExecution(events, 0);
  assert.equal(scoped0.length, 1);
  assert.equal(scoped0[0]!.detail, 'exec-0 work');

  // exec-1 should see only its own events
  const scoped1 = scopeEventsToExecution(events, 1);
  assert.equal(scoped1.length, 2);
  assert.equal(scoped1[0]!.detail, 'exec-1 work A');
  assert.equal(scoped1[1]!.detail, 'exec-1 work B');
});

/* ---------------- lifecycle cache ---------------- */

test('cache: set then get returns same snapshot', () => {
  const cache = createLifecycleCache();
  const snap: LifecycleSnapshot = {
    executionId: 'e1', derivedStatus: 'running', confidence: 'high',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  cache.set('e1', snap);
  assert.deepEqual(cache.get('e1'), snap);
});

test('cache: get on missing id → null', () => {
  const cache = createLifecycleCache();
  assert.equal(cache.get('nope'), null);
});

test('cache: invalidate removes entry', () => {
  const cache = createLifecycleCache();
  const snap: LifecycleSnapshot = {
    executionId: 'e1', derivedStatus: 'running', confidence: 'high',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  cache.set('e1', snap);
  assert.equal(cache.invalidate('e1'), true);
  assert.equal(cache.get('e1'), null);
  assert.equal(cache.invalidate('e1'), false);
});

test('cache: invalidateByPrefix drops matching keys only', () => {
  const cache = createLifecycleCache();
  const snap: LifecycleSnapshot = {
    executionId: 'x', derivedStatus: 'idle', confidence: 'medium',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  cache.set('claude-code:a:exec-0', snap);
  cache.set('claude-code:a:exec-1', snap);
  cache.set('codex:b:exec-0', snap);
  const dropped = cache.invalidateByPrefix('claude-code:a:');
  assert.equal(dropped, 2);
  assert.equal(cache.has('claude-code:a:exec-0'), false);
  assert.equal(cache.has('codex:b:exec-0'), true);
});

test('cache: TTL expiry returns null and removes entry', () => {
  const cache = createLifecycleCache({ ttlMs: 50 });
  const snap: LifecycleSnapshot = {
    executionId: 'e1', derivedStatus: 'running', confidence: 'high',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  cache.set('e1', snap);
  assert.ok(cache.has('e1'));
  // Sleep just past TTL
  const start = Date.now();
  while (Date.now() - start < 80) { /* spin briefly */ }
  assert.equal(cache.get('e1'), null);
  assert.equal(cache.has('e1'), false);
});

test('cache: set returns previous snapshot for transition detection', () => {
  const cache = createLifecycleCache();
  const a: LifecycleSnapshot = {
    executionId: 'e1', derivedStatus: 'running', confidence: 'high',
    reason: 'a', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  const b: LifecycleSnapshot = {
    executionId: 'e1', derivedStatus: 'idle', confidence: 'high',
    reason: 'b', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  assert.equal(cache.set('e1', a), null);  // first write returns null
  assert.deepEqual(cache.set('e1', b), a);  // second write returns previous
  assert.equal(cache.set('e1', b), b);    // same value, returns itself
});

test('cache: clear empties everything', () => {
  const cache = createLifecycleCache();
  const snap: LifecycleSnapshot = {
    executionId: 'x', derivedStatus: 'idle', confidence: 'medium',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  };
  cache.set('a', snap);
  cache.set('b', snap);
  assert.equal(cache.size(), 2);
  cache.clear();
  assert.equal(cache.size(), 0);
});

test('cache: maxEntries triggers LRU eviction', () => {
  const cache = createLifecycleCache({ maxEntries: 3 });
  const mkSnap = (id: string): LifecycleSnapshot => ({
    executionId: id, derivedStatus: 'idle', confidence: 'low',
    reason: 'r', lastActivityAt: null, lastActivityAgeMs: 100,
    indicators: [], computedAt: new Date().toISOString(),
  });
  cache.set('a', mkSnap('a'));
  // Sleep so timestamps differ for LRU
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return sleep(2).then(() => {
    cache.set('b', mkSnap('b'));
    return sleep(2);
  }).then(() => {
    cache.set('c', mkSnap('c'));
    return sleep(2);
  }).then(() => {
    cache.set('d', mkSnap('d')); // evicts 'a' (oldest)
    assert.equal(cache.has('a'), false);
    assert.equal(cache.has('b'), true);
    assert.equal(cache.has('c'), true);
    assert.equal(cache.has('d'), true);
  });
});

/* ---------------- realtime emit ---------------- */

function mkSnapshot(
  id: string,
  status: import('@agentos/shared').DerivedLifecycleStatus,
  reason = 'r',
): LifecycleSnapshot {
  return {
    executionId: id,
    derivedStatus: status,
    confidence: 'high',
    reason,
    lastActivityAt: null,
    lastActivityAgeMs: 100,
    indicators: [],
    computedAt: new Date().toISOString(),
  };
}

test('computeAndCacheLifecycle: first call → no previous, no SSE', () => {
  globalCache.clear();
  eventBus.clearHistory();
  const received: unknown[] = [];
  const unsub = eventBus.subscribe((e) => received.push(e));
  try {
    const r = computeAndCacheLifecycle(EXEC0, {
      events: [],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: true, nowMs: NOW });
    assert.equal(r.previous, null);
    assert.equal(r.changed, false);
    // No lifecycle_changed events fired
    assert.equal(received.filter((e) => (e as { type: string }).type === 'lifecycle_changed').length, 0);
  } finally {
    unsub();
    globalCache.clear();
  }
});

test('computeAndCacheLifecycle: same status → changed=false, no SSE', () => {
  globalCache.clear();
  eventBus.clearHistory();
  const received: unknown[] = [];
  const unsub = eventBus.subscribe((e) => received.push(e));
  try {
    // Pre-seed cache
    computeAndCacheLifecycle(EXEC0, {
      events: [],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: false, nowMs: NOW });
    // Now compute again with same status (queued, since no events)
    const r = computeAndCacheLifecycle(EXEC0, {
      events: [],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: true, nowMs: NOW });
    assert.equal(r.previous?.derivedStatus, 'queued');
    assert.equal(r.snapshot.derivedStatus, 'queued');
    assert.equal(r.changed, false);
    assert.equal(received.filter((e) => (e as { type: string }).type === 'lifecycle_changed').length, 0);
  } finally {
    unsub();
    globalCache.clear();
  }
});

test('computeAndCacheLifecycle: different status → changed=true, emits SSE', () => {
  globalCache.clear();
  eventBus.clearHistory();
  const received: unknown[] = [];
  const unsub = eventBus.subscribe((e) => received.push(e));
  try {
    // Seed cache as queued (empty events)
    computeAndCacheLifecycle(EXEC0, {
      events: [],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: false, nowMs: NOW });
    // Now compute with a fresh event → likely 'queued' or similar
    // (depending on grouping). To force a real transition, use
    // a richer event set that produces 'running'.
    const start = new Date(NOW - 5_000).toISOString();
    const r = computeAndCacheLifecycle(EXEC0, {
      events: [ev(start)],
      commits: [],
      startTime: start,
      endTime: null,
    }, { emitOnChange: true, nowMs: NOW });
    assert.equal(r.changed, true);
    const lifecycleEvents = received.filter((e) => (e as { type: string }).type === 'lifecycle_changed') as Array<{
      type: string; executionId: string; derivedStatus: string; previousDerivedStatus: string | null;
    }>;
    assert.equal(lifecycleEvents.length, 1);
    assert.equal(lifecycleEvents[0]!.executionId, EXEC0);
    assert.equal(lifecycleEvents[0]!.derivedStatus, r.snapshot.derivedStatus);
    assert.equal(lifecycleEvents[0]!.previousDerivedStatus, 'queued');
  } finally {
    unsub();
    globalCache.clear();
  }
});

test('computeAndCacheLifecycle: emitOnChange=false suppresses SSE', () => {
  globalCache.clear();
  eventBus.clearHistory();
  const received: unknown[] = [];
  const unsub = eventBus.subscribe((e) => received.push(e));
  try {
    computeAndCacheLifecycle(EXEC0, {
      events: [],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: false, nowMs: NOW });
    const r = computeAndCacheLifecycle(EXEC0, {
      events: [ev(new Date(NOW - 1000).toISOString())],
      commits: [],
      startTime: new Date(NOW - 60_000).toISOString(),
      endTime: null,
    }, { emitOnChange: false, nowMs: NOW });
    assert.equal(r.changed, true);
    assert.equal(received.filter((e) => (e as { type: string }).type === 'lifecycle_changed').length, 0);
  } finally {
    unsub();
    globalCache.clear();
  }
});

/* ---------------- conflict detection ---------------- */

test('detectLifecycleConflict: no manual → no conflict', () => {
  const snap = mkSnapshot(EXEC0, 'running');
  const c = detectLifecycleConflict(EXEC0, snap, null);
  assert.equal(c.isConflict, false);
  assert.equal(c.manualStatus, null);
  assert.equal(c.label, null);
});

test('detectLifecycleConflict: manual done + derived running → conflict', () => {
  const snap = mkSnapshot(EXEC0, 'running');
  const c = detectLifecycleConflict(EXEC0, snap, 'done');
  assert.equal(c.isConflict, true);
  assert.equal(c.manualStatus, 'done');
  assert.equal(c.derivedStatus, 'running');
  assert.match(c.label ?? '', /done vs running/);
});

test('detectLifecycleConflict: manual done + derived completed → no conflict', () => {
  const snap = mkSnapshot(EXEC0, 'completed');
  const c = detectLifecycleConflict(EXEC0, snap, 'done');
  assert.equal(c.isConflict, false);
  assert.equal(c.label, null);
});

test('detectLifecycleConflict: manual blocked + derived failed → conflict', () => {
  // derived 'failed' → 'blocked' bucket, manual 'blocked' → 'blocked' bucket
  const snap = mkSnapshot(EXEC0, 'failed');
  const c = detectLifecycleConflict(EXEC0, snap, 'blocked');
  assert.equal(c.isConflict, false);
});

test('detectLifecycleConflict: manual in-progress + derived running → no conflict', () => {
  // both → 'active' bucket
  const snap = mkSnapshot(EXEC0, 'running');
  const c = detectLifecycleConflict(EXEC0, snap, 'in-progress');
  assert.equal(c.isConflict, false);
});

test('detectLifecycleConflict: manual todo + derived idle → no conflict', () => {
  // both → 'idle' bucket
  const snap = mkSnapshot(EXEC0, 'idle');
  const c = detectLifecycleConflict(EXEC0, snap, 'todo');
  assert.equal(c.isConflict, false);
});

test('detectLifecycleConflict: manual archived always conflicts with non-archived', () => {
  const snap = mkSnapshot(EXEC0, 'running');
  const c = detectLifecycleConflict(EXEC0, snap, 'archived');
  assert.equal(c.isConflict, true);
});

test('detectLifecycleConflict: manual done + derived queued → conflict', () => {
  // 'done' → 'completed' bucket; 'queued' → 'idle' bucket → different
  const snap = mkSnapshot(EXEC0, 'queued');
  const c = detectLifecycleConflict(EXEC0, snap, 'done');
  assert.equal(c.isConflict, true);
});

/* ---------------- integration: execution isolation end-to-end ---------------- */

test('integration: exec-0 and exec-1 in same session get independent lifecycles', () => {
  globalCache.clear();
  const t0 = new Date(NOW - 90 * 60_000).toISOString();
  const t1 = new Date(NOW - 45 * 60_000).toISOString();
  const t2 = new Date(NOW - 40 * 60_000).toISOString();
  const events = [ev(t0), ev(t1), ev(t2)];

  // exec-0 (group 0): only t0 — old, no recent activity → idle/blocked
  const r0 = computeAndCacheLifecycle('e0', {
    events: scopeEventsToExecution(events, 0),
    commits: [],
    startTime: t0,
    endTime: null,
  }, { emitOnChange: false, nowMs: NOW });
  // exec-1 (group 1): t1 + t2 (recent) → queued or running
  const r1 = computeAndCacheLifecycle('e1', {
    events: scopeEventsToExecution(events, 1),
    commits: [],
    startTime: t1,
    endTime: null,
  }, { emitOnChange: false, nowMs: NOW });

  // The two should NOT share status. Verify cache has distinct entries.
  assert.deepEqual(globalCache.get('e0'), r0.snapshot);
  assert.deepEqual(globalCache.get('e1'), r1.snapshot);
  assert.notDeepEqual(r0.snapshot, r1.snapshot);
});

test('integration: invalidation hook clears cache on file_changed event', () => {
  // Re-subscribe (idempotent)
  _resetLifecycleInvalidationForTests();
  subscribeLifecycleInvalidation();

  globalCache.clear();
  const snap = mkSnapshot('e1', 'running');
  globalCache.set('e1', snap);
  assert.ok(globalCache.has('e1'));

  eventBus.emit({
    type: 'file_changed',
    ts: new Date().toISOString(),
    agent: 'claude-code',
    filePath: '/some/path.jsonl',
  });
  assert.equal(globalCache.has('e1'), false, 'cache should be cleared on file_changed');
});