import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventBus, type RealtimeEvent } from '../src/event-bus.js';
import { Db } from '../src/db.js';
import { deriveAgentStatus, ACTIVE_THRESHOLD_S, IDLE_THRESHOLD_S } from '../src/agent-status.js';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-rt-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('EventBus: subscribe receives future events', () => {
  const bus = new EventBus();
  const received: RealtimeEvent[] = [];
  bus.subscribe((ev) => received.push(ev));
  bus.emit({ type: 'file_changed', ts: new Date().toISOString(), agent: 'claude-code', filePath: '/a' });
  bus.emit({ type: 'scan_completed', ts: new Date().toISOString(), agent: 'claude-code', ms: 10, sessions: 1, usage: 1, events: 2, duplicatesPrevented: 0 });
  assert.equal(received.length, 2);
  assert.equal(received[0].type, 'file_changed');
  assert.equal(received[1].type, 'scan_completed');
});

test('EventBus: unsubscribe stops delivery', () => {
  const bus = new EventBus();
  const received: RealtimeEvent[] = [];
  const unsub = bus.subscribe((ev) => received.push(ev));
  bus.emit({ type: 'file_changed', ts: new Date().toISOString(), agent: 'grok', filePath: '/x' });
  unsub();
  bus.emit({ type: 'file_changed', ts: new Date().toISOString(), agent: 'grok', filePath: '/y' });
  assert.equal(received.length, 1);
});

test('EventBus: late subscriber replays history', () => {
  const bus = new EventBus({ historySize: 5 });
  bus.emit({ type: 'file_changed', ts: 't1', agent: 'codex', filePath: '/a' });
  bus.emit({ type: 'file_changed', ts: 't2', agent: 'codex', filePath: '/b' });
  bus.emit({ type: 'file_changed', ts: 't3', agent: 'codex', filePath: '/c' });
  const received: RealtimeEvent[] = [];
  bus.subscribe((ev) => received.push(ev));
  assert.equal(received.length, 3);
  assert.equal(received[0].type, 'file_changed');
});

test('EventBus: history is bounded', () => {
  const bus = new EventBus({ historySize: 3 });
  for (let i = 0; i < 10; i++) {
    bus.emit({ type: 'file_changed', ts: `t${i}`, agent: 'grok', filePath: `/f${i}` });
  }
  assert.equal(bus.snapshot().length, 3);
  // only the last 3 should be retained
  assert.equal(bus.snapshot()[0].ts, 't7');
});

test('EventBus: subscriber throws do not break other subscribers', () => {
  const bus = new EventBus();
  const seen: number[] = [];
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((ev) => seen.push(ev.ts.length));
  bus.emit({ type: 'file_changed', ts: 'hello', agent: 'grok', filePath: '/x' });
  assert.equal(seen.length, 1);
});

/* ---------- agent status projection ---------- */

test('deriveAgentStatus: no events → unknown', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, 'claude-code');
    assert.equal(rows[0].status, 'unknown');
    assert.equal(rows[0].lastActivity, undefined);
  } finally { teardown(); }
});

test('deriveAgentStatus: recent event → active', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
    db.upsertSession({
      id: 'claude-code:s', agentId: 'claude-code', agentType: 'claude-code',
      externalId: 's', project: '/p', projectDisplay: '/p',
      startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      status: 'completed', model: 'm',
      messageCount: 1, totalInputTokens: 1, totalOutputTokens: 1, totalTokens: 2,
      estimatedCost: 0, fileOps: 0, toolCalls: 0,
    });
    db.insertEvent({
      id: 'e1', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'tool-call',
      timestamp: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      detail: 'Read dashboard.ts',
    });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].lastAction, 'Read dashboard.ts');
    assert.equal(rows[0].lastProject, '/p');
  } finally { teardown(); }
});

test(`deriveAgentStatus: event > ${ACTIVE_THRESHOLD_S}s ago → idle`, () => {
  setup();
  try {
    db.upsertAgent({ id: 'grok', name: 'Grok', type: 'grok', dataDir: '/x', enabled: true });
    db.insertEvent({
      id: 'e1', sessionId: 's', agentId: 'grok', type: 'message',
      timestamp: new Date(Date.now() - (ACTIVE_THRESHOLD_S + 30) * 1000).toISOString(),
    });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows[0].status, 'idle');
  } finally { teardown(); }
});

test(`deriveAgentStatus: event > ${IDLE_THRESHOLD_S}s ago → unknown`, () => {
  setup();
  try {
    db.upsertAgent({ id: 'codex', name: 'Codex', type: 'codex', dataDir: '/x', enabled: true });
    db.insertEvent({
      id: 'e1', sessionId: 's', agentId: 'codex', type: 'message',
      timestamp: new Date(Date.now() - (IDLE_THRESHOLD_S + 60) * 1000).toISOString(),
    });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows[0].status, 'unknown');
  } finally { teardown(); }
});

test('deriveAgentStatus: picks the MOST RECENT event per agent', () => {
  setup();
  try {
    db.upsertAgent({ id: 'grok', name: 'Grok', type: 'grok', dataDir: '/x', enabled: true });
    // old event (>IDLE)
    db.insertEvent({ id: 'old', sessionId: 's', agentId: 'grok', type: 'tool-call',
      timestamp: new Date(Date.now() - 600_000).toISOString(), detail: 'old action' });
    // new event (active)
    db.insertEvent({ id: 'new', sessionId: 's', agentId: 'grok', type: 'message',
      timestamp: new Date(Date.now() - 1000).toISOString(), detail: 'new action' });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].lastAction, 'new action');
    assert.equal(rows[0].lastEventType, 'message');
  } finally { teardown(); }
});

test('deriveAgentStatus: disabled agent → unknown', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude', type: 'claude-code', dataDir: '/x', enabled: false });
    db.insertEvent({
      id: 'e1', sessionId: 's', agentId: 'claude-code', type: 'tool-call',
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });
    const rows = deriveAgentStatus(db.raw);
    assert.equal(rows[0].status, 'unknown');
  } finally { teardown(); }
});