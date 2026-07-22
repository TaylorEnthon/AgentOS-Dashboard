import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db, humanAction } from '../src/db.js';
import type { ActivityEvent, AgentSession } from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-tl-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function seedAgent(): void {
  db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
  db.upsertAgent({ id: 'grok', name: 'Grok', type: 'grok', dataDir: '/y', enabled: true });
}

function seedSession(id: string, project: string, projectDisplay: string, title?: string): AgentSession {
  const s: AgentSession = {
    id, agentId: id.split(':')[0], agentType: 'claude-code', externalId: id,
    project, projectDisplay, title,
    startTime: '2026-07-22T10:00:00.000Z', endTime: '2026-07-22T10:30:00.000Z',
    status: 'completed', model: 'm',
    messageCount: 1, totalInputTokens: 1, totalOutputTokens: 1, totalTokens: 2,
    estimatedCost: 0, fileOps: 0, toolCalls: 0,
  };
  db.upsertSession(s);
  return s;
}

function pushEvent(e: Omit<ActivityEvent, 'source'>): void {
  db.insertEvent({ ...e, source: { sourceFile: '/x', sourceProvider: e.agentId as ActivityEvent['agentId'], sourceId: e.id, collectedAt: new Date().toISOString() } });
}

/* ---------------- humanAction helper ---------------- */

test('humanAction: detail provided → typeLabel + detail', () => {
  assert.equal(humanAction('tool-call', 'Read dashboard.ts'), 'Tool call · Read dashboard.ts');
});

test('humanAction: long detail is truncated', () => {
  const long = 'x'.repeat(200);
  const out = humanAction('tool-call', long);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 170);
});

test('humanAction: no detail → just typeLabel', () => {
  assert.equal(humanAction('session-start', null), 'Session started');
  assert.equal(humanAction('session-start', ''), 'Session started');
});

test('humanAction: unknown type falls through', () => {
  assert.equal(humanAction('custom-thing', 'foo'), 'custom-thing · foo');
});

/* ---------------- listTimeline projection ---------------- */

test('listTimeline: returns events joined with session title + project', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s1', '/p/one', 'one', 'My title');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'message',
      timestamp: '2026-07-22T10:05:00.000Z', detail: 'hi' });
    const items = db.listTimeline({});
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'e1');
    assert.equal(items[0].agentId, 'claude-code');
    assert.equal(items[0].agentType, 'claude-code');
    assert.equal(items[0].sessionId, 'claude-code:s1');
    assert.equal(items[0].sessionTitle, 'My title');
    assert.equal(items[0].project, '/p/one');
    assert.equal(items[0].projectDisplay, 'one');
    assert.equal(items[0].action, 'Message · hi');
  } finally { teardown(); }
});

test('listTimeline: ordered newest-first', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s', '/p', '/p');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    pushEvent({ id: 'e2', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:10:00.000Z' });
    pushEvent({ id: 'e3', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:05:00.000Z' });
    const items = db.listTimeline({});
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.id), ['e2', 'e3', 'e1']);
  } finally { teardown(); }
});

test('listTimeline: filter by agent', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s1', '/p/a', '/p/a');
    seedSession('grok:s2', '/p/b', '/p/b');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    pushEvent({ id: 'e2', sessionId: 'grok:s2', agentId: 'grok', type: 'message', timestamp: '2026-07-22T10:01:00.000Z' });
    pushEvent({ id: 'e3', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'tool-call', timestamp: '2026-07-22T10:02:00.000Z', detail: 'Read foo.ts' });
    const onlyClaude = db.listTimeline({ agentId: 'claude-code' });
    assert.equal(onlyClaude.length, 2);
    assert.ok(onlyClaude.every((i) => i.agentId === 'claude-code'));
    assert.deepEqual(onlyClaude.map((i) => i.id), ['e3', 'e1']);
  } finally { teardown(); }
});

test('listTimeline: filter by session', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s1', '/p', '/p');
    seedSession('claude-code:s2', '/p', '/p');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    pushEvent({ id: 'e2', sessionId: 'claude-code:s2', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:01:00.000Z' });
    pushEvent({ id: 'e3', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:02:00.000Z' });
    const s1 = db.listTimeline({ sessionId: 'claude-code:s1' });
    assert.equal(s1.length, 2);
    assert.deepEqual(s1.map((i) => i.id), ['e3', 'e1']);
  } finally { teardown(); }
});

test('listTimeline: filter by project (joins through sessions)', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s1', '/p/one', 'one');
    seedSession('claude-code:s2', '/p/two', 'two');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s1', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    pushEvent({ id: 'e2', sessionId: 'claude-code:s2', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:01:00.000Z' });
    const one = db.listTimeline({ project: '/p/one' });
    assert.equal(one.length, 1);
    assert.equal(one[0].id, 'e1');
    assert.equal(one[0].project, '/p/one');
  } finally { teardown(); }
});

test('listTimeline: time-range filter (from + to)', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s', '/p', '/p');
    pushEvent({ id: 'e1', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    pushEvent({ id: 'e2', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:30:00.000Z' });
    pushEvent({ id: 'e3', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T11:00:00.000Z' });
    const window = db.listTimeline({ from: '2026-07-22T10:15:00.000Z', to: '2026-07-22T10:45:00.000Z' });
    assert.equal(window.length, 1);
    assert.equal(window[0].id, 'e2');
  } finally { teardown(); }
});

test('listTimeline: limit is honored (default 200, max 1000)', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s', '/p', '/p');
    for (let i = 0; i < 50; i++) {
      pushEvent({
        id: `e${i}`, sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message',
        timestamp: new Date(2026, 6, 22, 10, 0, i).toISOString(),
      });
    }
    const all = db.listTimeline({});
    assert.equal(all.length, 50);
    const ten = db.listTimeline({ limit: 10 });
    assert.equal(ten.length, 10);
  } finally { teardown(); }
});

test('listTimeline: events with no matching session still appear (LEFT JOIN)', () => {
  setup();
  try {
    seedAgent();
    // Insert an event with a session_id that doesn't exist in sessions
    pushEvent({ id: 'orphan', sessionId: 'claude-code:orphan', agentId: 'claude-code', type: 'message', timestamp: '2026-07-22T10:00:00.000Z' });
    const items = db.listTimeline({});
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'orphan');
    assert.equal(items[0].project, '');
    assert.equal(items[0].projectDisplay, '');
    assert.equal(items[0].sessionTitle, null);
  } finally { teardown(); }
});

test('listTimeline: parses meta JSON', () => {
  setup();
  try {
    seedAgent();
    seedSession('claude-code:s', '/p', '/p');
    db.raw.prepare(
      `INSERT INTO activity_events (id, session_id, agent_id, type, timestamp, detail, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('e-meta', 'claude-code:s', 'claude-code', 'tool-call', '2026-07-22T10:00:00Z', 'Read x.ts', JSON.stringify({ file: 'x.ts', line: 42 }));
    const items = db.listTimeline({});
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].meta, { file: 'x.ts', line: 42 });
  } finally { teardown(); }
});