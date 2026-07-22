/**
 * v1.0 Execution Status History tests.
 *
 * Covers:
 *  - execution_status_history table auto-migration (new DB + existing v0.9 DB)
 *  - recordStatusChange: insert + dedup semantics
 *  - getExecutionStatusHistory: ordering (oldest first) + limit
 *  - rowToStatusHistory: defensive against garbage values
 *  - "manual change" workflow simulated at the DB layer
 *    (the route handler applies recordStatusChange when before/after differ)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import type { AgentSession, EffectiveExecutionStatus } from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-sh-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function seedSession(id: string): AgentSession {
  const s: AgentSession = {
    id,
    agentId: id.split(':')[0],
    agentType: 'claude-code',
    externalId: id,
    project: '/p/test',
    projectDisplay: '/p/test',
    title: 'Old',
    startTime: '2026-07-22T10:00:00.000Z',
    endTime: '2026-07-22T10:30:00.000Z',
    status: 'completed',
    model: 'm',
    messageCount: 1,
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalTokens: 2,
    estimatedCost: 0,
    fileOps: 0,
    toolCalls: 0,
  };
  db.upsertSession(s);
  return s;
}

/* ---------------- migration ---------------- */

test('execution_status_history table is auto-created on first Db open', () => {
  setup();
  try {
    const cols = db.raw.prepare(`PRAGMA table_info(execution_status_history)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('id'));
    assert.ok(names.includes('execution_id'));
    assert.ok(names.includes('from_status'));
    assert.ok(names.includes('to_status'));
    assert.ok(names.includes('source'));
    assert.ok(names.includes('created_at'));
  } finally { teardown(); }
});

test('Db construction on an existing v0.9 DB picks up execution_status_history without touching old data', () => {
  setup();
  try {
    seedSession('claude-code:abc');
    db.close();
    db = new Db(path.join(tmpRoot, 'test.db'));
    // Session untouched.
    const s = db.getSession('claude-code:abc');
    assert.ok(s);
    assert.equal(s!.title, 'Old');
    // New table present.
    const cols = db.raw.prepare(`PRAGMA table_info(execution_status_history)`).all();
    assert.ok(cols.length > 0);
  } finally { teardown(); }
});

/* ---------------- recordStatusChange + read ---------------- */

test('recordStatusChange: single insert + read', () => {
  setup();
  try {
    db.recordStatusChange('claude-code:abc:exec-0', null, 'todo', 'manual', '2026-07-22T10:00:00.000Z');
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.equal(history.length, 1);
    assert.equal(history[0]!.executionId, 'claude-code:abc:exec-0');
    assert.equal(history[0]!.fromStatus, null);
    assert.equal(history[0]!.toStatus, 'todo');
    assert.equal(history[0]!.source, 'manual');
    assert.equal(history[0]!.createdAt, '2026-07-22T10:00:00.000Z');
  } finally { teardown(); }
});

test('recordStatusChange: multiple transitions, ordered oldest-first', () => {
  setup();
  try {
    db.recordStatusChange('claude-code:abc:exec-0', null,         'todo',        'manual', '2026-07-22T10:00:00.000Z');
    db.recordStatusChange('claude-code:abc:exec-0', 'todo',       'in-progress', 'manual', '2026-07-22T10:30:00.000Z');
    db.recordStatusChange('claude-code:abc:exec-0', 'in-progress', 'blocked',     'manual', '2026-07-22T11:00:00.000Z');
    db.recordStatusChange('claude-code:abc:exec-0', 'blocked',    'done',        'manual', '2026-07-22T11:30:00.000Z');
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.equal(history.length, 4);
    assert.deepEqual(history.map((h) => h.toStatus), ['todo', 'in-progress', 'blocked', 'done']);
    assert.deepEqual(history.map((h) => h.fromStatus), [null, 'todo', 'in-progress', 'blocked']);
  } finally { teardown(); }
});

test('recordStatusChange: ids are monotonically increasing', () => {
  setup();
  try {
    db.recordStatusChange('claude-code:abc:exec-0', null, 'todo', 'manual');
    db.recordStatusChange('claude-code:abc:exec-0', 'todo', 'done', 'manual');
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.ok(history[1]!.id > history[0]!.id);
  } finally { teardown(); }
});

test('recordStatusChange: dedup is the caller\'s responsibility (no automatic suppression)', () => {
  // We explicitly do NOT dedup here — if a caller writes the same
  // transition twice (e.g. two consecutive PATCHes both setting
  // manualStatus=done), we record both. The route handler compares
  // before/after and skips when equal.
  setup();
  try {
    db.recordStatusChange('claude-code:abc:exec-0', 'todo', 'done', 'manual');
    db.recordStatusChange('claude-code:abc:exec-0', 'todo', 'done', 'manual');
    assert.equal(db.getExecutionStatusHistory('claude-code:abc:exec-0').length, 2);
  } finally { teardown(); }
});

test('recordStatusChange: cross-execution isolation', () => {
  setup();
  try {
    db.recordStatusChange('claude-code:abc:exec-0', null, 'todo', 'manual');
    db.recordStatusChange('claude-code:abc:exec-1', null, 'done', 'manual');
    const a = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    const b = db.getExecutionStatusHistory('claude-code:abc:exec-1');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.toStatus, 'todo');
    assert.equal(b[0]!.toStatus, 'done');
  } finally { teardown(); }
});

test('getExecutionStatusHistory: limit is honored', () => {
  setup();
  try {
    for (let i = 0; i < 5; i++) {
      db.recordStatusChange('claude-code:abc:exec-0', null, 'todo', 'manual', `2026-07-22T10:0${i}:00.000Z`);
    }
    assert.equal(db.getExecutionStatusHistory('claude-code:abc:exec-0', 3).length, 3);
  } finally { teardown(); }
});

test('getExecutionStatusHistory: empty result for unknown execution', () => {
  setup();
  try {
    assert.deepEqual(db.getExecutionStatusHistory('nope'), []);
  } finally { teardown(); }
});

/* ---------------- "manual change" workflow (route-equivalent simulation) ---------------- */

test('manual change workflow: PATCH-equivalent dedup behavior', () => {
  // This mirrors what the route handler should do:
  //   const before = db.getExecutionMetadata(id);
  //   const after  = db.upsertExecutionMetadata(id, patch);
  //   if (before?.manualStatus !== after.manualStatus) {
  //     db.recordStatusChange(id, before?.manualStatus ?? null, after.manualStatus, 'manual');
  //   }
  setup();
  try {
    const id = 'claude-code:abc:exec-0';
    // Initial state: no metadata → no manual override.
    const before1 = db.getExecutionMetadata(id);
    assert.equal(before1, null);
    db.upsertExecutionMetadata(id, { manualStatus: 'todo' });
    const after1 = db.getExecutionMetadata(id);
    // Route would record: from null → 'todo' (manual).
    db.recordStatusChange(id, before1?.manualStatus ?? null, after1!.manualStatus!, 'manual');
    assert.equal(db.getExecutionStatusHistory(id).length, 1);

    // Second PATCH: same status → DO NOT record (skip).
    const before2 = db.getExecutionMetadata(id);
    db.upsertExecutionMetadata(id, { manualStatus: 'todo' });
    const after2 = db.getExecutionMetadata(id);
    if (before2?.manualStatus !== after2?.manualStatus) {
      db.recordStatusChange(id, before2?.manualStatus ?? null, after2!.manualStatus!, 'manual');
    }
    assert.equal(db.getExecutionStatusHistory(id).length, 1, 'same status must not create a duplicate');

    // Third PATCH: change to done → record.
    const before3 = db.getExecutionMetadata(id);
    db.upsertExecutionMetadata(id, { manualStatus: 'done' });
    const after3 = db.getExecutionMetadata(id);
    if (before3?.manualStatus !== after3?.manualStatus) {
      db.recordStatusChange(id, before3?.manualStatus ?? null, after3!.manualStatus!, 'manual');
    }
    assert.equal(db.getExecutionStatusHistory(id).length, 2);
    assert.equal(db.getExecutionStatusHistory(id)[1]!.toStatus, 'done');

    // Fourth PATCH: clear (null) → record.
    const before4 = db.getExecutionMetadata(id);
    db.upsertExecutionMetadata(id, { manualStatus: null });
    const after4 = db.getExecutionMetadata(id);
    if (before4?.manualStatus !== after4?.manualStatus) {
      db.recordStatusChange(id, before4?.manualStatus ?? null, after4!.manualStatus ?? 'unknown', 'manual');
    }
    assert.equal(db.getExecutionStatusHistory(id).length, 3);
    assert.equal(db.getExecutionStatusHistory(id)[2]!.toStatus, 'unknown');
  } finally { teardown(); }
});

/* ---------------- defensive rowToStatusHistory ---------------- */

test('rowToStatusHistory: garbage to_status falls back to "unknown"', () => {
  setup();
  try {
    db.raw.prepare(
      `INSERT INTO execution_status_history (execution_id, from_status, to_status, source, created_at)
       VALUES (?, NULL, ?, ?, ?)`,
    ).run('claude-code:abc:exec-0', 'something-bogus', 'manual', new Date().toISOString());
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.equal(history.length, 1);
    assert.equal(history[0]!.toStatus, 'unknown');
  } finally { teardown(); }
});

test('rowToStatusHistory: garbage source falls back to "auto"', () => {
  setup();
  try {
    db.raw.prepare(
      `INSERT INTO execution_status_history (execution_id, from_status, to_status, source, created_at)
       VALUES (?, NULL, ?, ?, ?)`,
    ).run('claude-code:abc:exec-0', 'todo', 'something-bogus', new Date().toISOString());
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.equal(history[0]!.source, 'auto');
  } finally { teardown(); }
});

test('rowToStatusHistory: from_status garbage becomes null', () => {
  setup();
  try {
    db.raw.prepare(
      `INSERT INTO execution_status_history (execution_id, from_status, to_status, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code:abc:exec-0', 'bogus', 'todo', 'manual', new Date().toISOString());
    const history = db.getExecutionStatusHistory('claude-code:abc:exec-0');
    assert.equal(history[0]!.fromStatus, null);
  } finally { teardown(); }
});

test('rowToStatusHistory: every valid effective status is preserved', () => {
  setup();
  try {
    const all: EffectiveExecutionStatus[] = [
      'running', 'completed', 'unknown',
      'todo', 'in-progress', 'done', 'blocked', 'archived',
    ];
    for (const s of all) {
      db.recordStatusChange(`claude-code:abc:exec-${all.indexOf(s)}`, null, s, 'manual');
    }
    const seen = db.raw.prepare(
      `SELECT DISTINCT to_status FROM execution_status_history ORDER BY to_status`,
    ).all() as Array<{ to_status: string }>;
    assert.equal(seen.length, all.length);
    for (const s of all) {
      assert.ok(seen.some((r) => r.to_status === s), `missing status ${s}`);
    }
  } finally { teardown(); }
});