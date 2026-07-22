/**
 * v0.9 Execution Workspace tests.
 *
 * Covers:
 *  - execution_metadata table auto-migration (new DB + existing v0.8 DB)
 *  - CRUD: get / upsert (merge) / patch merge / bulk / delete / idempotent delete
 *  - corrupted JSON tags fallback
 *  - invalid manual_status fallback to null
 *  - applyExecutionMetadata precedence (manualStatus wins over derived)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import { applyExecutionMetadata, buildExecution } from '../src/execution-service.js';
import type {
  AgentSession,
  ExecutionMetadata,
  ManualExecutionStatus,
} from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-em-'));
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

test('execution_metadata table is auto-created on first Db open', () => {
  setup();
  try {
    const cols = db.raw.prepare(`PRAGMA table_info(execution_metadata)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('execution_id'));
    assert.ok(names.includes('display_name'));
    assert.ok(names.includes('note'));
    assert.ok(names.includes('tags'));
    assert.ok(names.includes('manual_status'));
    assert.ok(names.includes('created_at'));
    assert.ok(names.includes('updated_at'));
  } finally { teardown(); }
});

test('Db construction on an existing v0.8 DB picks up execution_metadata without touching old data', () => {
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
    const cols = db.raw.prepare(`PRAGMA table_info(execution_metadata)`).all();
    assert.ok(cols.length > 0);
  } finally { teardown(); }
});

/* ---------------- CRUD ---------------- */

test('getExecutionMetadata returns null when unset', () => {
  setup();
  try {
    assert.equal(db.getExecutionMetadata('claude-code:abc:exec-0'), null);
  } finally { teardown(); }
});

test('upsertExecutionMetadata creates + merges', () => {
  setup();
  try {
    // First write — only displayName.
    const m1 = db.upsertExecutionMetadata('claude-code:abc:exec-0', { displayName: 'First pass' });
    assert.equal(m1.displayName, 'First pass');
    assert.deepEqual(m1.tags, []);
    assert.equal(m1.manualStatus, null);
    assert.ok(m1.createdAt);
    // Second write — only tags. Should NOT clobber displayName.
    const m2 = db.upsertExecutionMetadata('claude-code:abc:exec-0', { tags: ['dev', 'v0.9'] });
    assert.equal(m2.displayName, 'First pass');
    assert.deepEqual(m2.tags, ['dev', 'v0.9']);
    assert.equal(m2.createdAt, m1.createdAt);
    assert.ok(m2.updatedAt >= m1.updatedAt);
  } finally { teardown(); }
});

test('upsertExecutionMetadata sets manualStatus', () => {
  setup();
  try {
    const m = db.upsertExecutionMetadata('claude-code:abc:exec-0', { manualStatus: 'blocked' });
    assert.equal(m.manualStatus, 'blocked');
    // Clear via null
    const m2 = db.upsertExecutionMetadata('claude-code:abc:exec-0', { manualStatus: null });
    assert.equal(m2.manualStatus, null);
  } finally { teardown(); }
});

test('upsertExecutionMetadata normalizes corrupted tags JSON on read', () => {
  setup();
  try {
    db.raw.prepare(
      `INSERT INTO execution_metadata (execution_id, display_name, note, tags, manual_status, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run('claude-code:abc:exec-0', 'not-valid-json', new Date().toISOString(), new Date().toISOString());
    const m = db.getExecutionMetadata('claude-code:abc:exec-0');
    assert.ok(m);
    assert.deepEqual(m!.tags, []);
  } finally { teardown(); }
});

test('rowToExecutionMetadata: invalid manual_status falls back to null', () => {
  setup();
  try {
    db.raw.prepare(
      `INSERT INTO execution_metadata (execution_id, display_name, note, tags, manual_status, created_at, updated_at)
       VALUES (?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run('claude-code:abc:exec-0', 'something-bogus', new Date().toISOString(), new Date().toISOString());
    const m = db.getExecutionMetadata('claude-code:abc:exec-0');
    assert.ok(m);
    assert.equal(m!.manualStatus, null);
  } finally { teardown(); }
});

test('getExecutionMetadataBulk: empty input + missing keys', () => {
  setup();
  try {
    assert.equal(db.getExecutionMetadataBulk([]).size, 0);
    db.upsertExecutionMetadata('claude-code:abc:exec-0', { displayName: 'X' });
    const map = db.getExecutionMetadataBulk(['claude-code:abc:exec-0', 'claude-code:abc:exec-99']);
    assert.equal(map.size, 1);
    assert.equal(map.get('claude-code:abc:exec-0')!.displayName, 'X');
    assert.equal(map.get('claude-code:abc:exec-99'), undefined);
  } finally { teardown(); }
});

test('deleteExecutionMetadata is idempotent', () => {
  setup();
  try {
    db.upsertExecutionMetadata('claude-code:abc:exec-0', { displayName: 'X' });
    db.deleteExecutionMetadata('claude-code:abc:exec-0');
    assert.equal(db.getExecutionMetadata('claude-code:abc:exec-0'), null);
    // Calling again is a no-op, not an error.
    db.deleteExecutionMetadata('claude-code:abc:exec-0');
    assert.equal(db.getExecutionMetadata('claude-code:abc:exec-0'), null);
  } finally { teardown(); }
});

/* ---------------- applyExecutionMetadata ---------------- */

function mkExec(overrides: Partial<import('@agentos/shared').AgentExecution> = {}): import('@agentos/shared').AgentExecution {
  const events = [];
  const e = buildExecution(
    'claude-code:abc',
    'claude-code',
    'claude-code',
    '/p/test',
    '/p/test',
    { index: 0, events, startTime: '2026-07-22T10:00:00.000Z', endTime: '2026-07-22T10:00:00.000Z' },
    [],
    [],
    Date.parse('2026-07-22T10:00:30.000Z'),
  );
  return { ...e, ...overrides };
}

test('applyExecutionMetadata: null meta → no change', () => {
  const e = mkExec();
  const out = applyExecutionMetadata(e, null);
  assert.equal(out.displayName, null);
  assert.deepEqual(out.tags, []);
  assert.equal(out.manualStatus, null);
  assert.equal(out.effectiveStatus, e.status);
});

test('applyExecutionMetadata: manualStatus overrides derived status', () => {
  // Auto status is 'running' (no commits, recent activity).
  const e = mkExec({ status: 'running' });
  const meta: ExecutionMetadata = {
    executionId: e.id,
    displayName: null,
    note: null,
    tags: [],
    manualStatus: 'blocked',
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
  const out = applyExecutionMetadata(e, meta);
  assert.equal(out.status, 'running');           // derived preserved
  assert.equal(out.manualStatus, 'blocked');     // manual applied
  assert.equal(out.effectiveStatus, 'blocked');  // manual wins
});

test('applyExecutionMetadata: null manualStatus → falls back to derived', () => {
  const e = mkExec({ status: 'completed' });
  const meta: ExecutionMetadata = {
    executionId: e.id,
    displayName: 'X',
    note: null,
    tags: ['a'],
    manualStatus: null,
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
  const out = applyExecutionMetadata(e, meta);
  assert.equal(out.manualStatus, null);
  assert.equal(out.effectiveStatus, 'completed');
});

test('applyExecutionMetadata: all five manual statuses round-trip', () => {
  const cases: ManualExecutionStatus[] = ['todo', 'in-progress', 'done', 'blocked', 'archived'];
  for (const ms of cases) {
    const e = mkExec();
    const meta: ExecutionMetadata = {
      executionId: e.id,
      displayName: null,
      note: null,
      tags: [],
      manualStatus: ms,
      createdAt: '2026-07-22T10:00:00.000Z',
      updatedAt: '2026-07-22T10:00:00.000Z',
    };
    const out = applyExecutionMetadata(e, meta);
    assert.equal(out.manualStatus, ms);
    assert.equal(out.effectiveStatus, ms);
  }
});

test('applyExecutionMetadata: displayName + tags applied', () => {
  const e = mkExec();
  const meta: ExecutionMetadata = {
    executionId: e.id,
    displayName: 'Implement Workspace',
    note: 'Notes here',
    tags: ['v0.9', 'feature'],
    manualStatus: 'done',
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
  const out = applyExecutionMetadata(e, meta);
  assert.equal(out.displayName, 'Implement Workspace');
  assert.deepEqual(out.tags, ['v0.9', 'feature']);
  assert.equal(out.manualStatus, 'done');
});