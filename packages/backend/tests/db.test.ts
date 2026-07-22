import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import type { AgentSession, UsageRecord, ActivityEvent } from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-db-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('agent upsert + list roundtrip', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
    db.upsertAgent({ id: 'codex', name: 'Codex', type: 'codex', dataDir: '/y', enabled: false });
    const agents = db.listAgents();
    assert.equal(agents.length, 2);
    assert.equal(agents.find((a) => a.id === 'claude-code')!.enabled, 1);
    assert.equal(agents.find((a) => a.id === 'codex')!.enabled, 0);
  } finally { teardown(); }
});

test('session upsert is idempotent and accumulates totals on update', () => {
  setup();
  try {
    const s: AgentSession = {
      id: 'claude-code:a',
      agentId: 'claude-code',
      agentType: 'claude-code',
      externalId: 'a',
      project: '/p',
      projectDisplay: '/p',
      startTime: '2026-07-22T10:00:00.000Z',
      endTime: '2026-07-22T10:01:00.000Z',
      status: 'completed',
      model: 'claude-sonnet-4',
      messageCount: 3,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      estimatedCost: 0.0001,
      fileOps: 1,
      toolCalls: 1,
    };
    db.upsertSession(s);
    db.upsertSession({ ...s, messageCount: 5, totalInputTokens: 200 });
    const stored = db.listSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].message_count, 5);
    assert.equal(stored[0].total_input_tokens, 200);
  } finally { teardown(); }
});

test('usage and event insert are idempotent via primary key', () => {
  setup();
  try {
    const u: UsageRecord = {
      id: 'u-1', sessionId: 's', agentId: 'a', model: 'm',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 15, estimatedCost: 0, timestamp: '2026-07-22T10:00:00Z',
    };
    const e: ActivityEvent = {
      id: 'e-1', sessionId: 's', agentId: 'a', type: 'message',
      timestamp: '2026-07-22T10:00:00Z', detail: 'hello',
    };
    db.insertUsage(u); db.insertUsage(u);
    db.insertEvent(e); db.insertEvent(e);
    assert.equal(db.listUsageForSession('s').length, 1);
    assert.equal(db.listEventsForSession('s').length, 1);
  } finally { teardown(); }
});

test('overview aggregates correctly', () => {
  setup();
  try {
    db.upsertSession(makeSession('s1', '2026-07-22T10:00:00Z', 'completed', 100, 50, 0.5));
    db.upsertSession(makeSession('s2', '2026-07-22T11:00:00Z', 'running',   200, 80, 0.7));
    db.upsertSession(makeSession('s3', '2026-07-21T10:00:00Z', 'completed', 50,  10, 0.1));
    const ov = db.overview();
    assert.equal(ov.totalSessions, 3);
    assert.equal(ov.activeSessions, 1);
    assert.equal(ov.todaySessions, 2);
    assert.equal(ov.todayTokens, 100+50+200+80);
    assert.ok(Math.abs(ov.totalCost - 1.3) < 0.0001);
    assert.equal(ov.byAgent.length, 1);
  } finally { teardown(); }
});

test('projects list aggregates per project', () => {
  setup();
  try {
    db.upsertProject({ path: '/p', displayName: '/p', lastSeen: '2026-07-22T10:00:00Z' });
    db.upsertSession(makeSession('a', '2026-07-22T10:00:00Z', 'completed', 100, 50, 0.5));
    const projects = db.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].totalTokens, 150);
    assert.equal(projects[0].sessionCount, 1);
  } finally { teardown(); }
});

test('settings roundtrip', () => {
  setup();
  try {
    db.setSetting('foo', 'bar');
    assert.equal(db.getSetting('foo'), 'bar');
    db.setSetting('foo', 'baz');
    assert.equal(db.getSetting('foo'), 'baz');
    db.deleteSetting('foo');
    assert.equal(db.getSetting('foo'), undefined);
  } finally { teardown(); }
});

function makeSession(id: string, start: string, status: string, inp: number, out: number, cost: number): AgentSession {
  return {
    id,
    agentId: 'claude-code',
    agentType: 'claude-code',
    externalId: id,
    project: '/p',
    projectDisplay: '/p',
    startTime: start,
    endTime: status === 'running' ? undefined : start,
    status: status as 'running' | 'completed' | 'failed' | 'unknown',
    model: 'm',
    messageCount: 1,
    totalInputTokens: inp,
    totalOutputTokens: out,
    totalTokens: inp + out,
    estimatedCost: cost,
    fileOps: 0,
    toolCalls: 0,
  };
}