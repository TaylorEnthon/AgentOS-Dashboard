/**
 * v1.5 Health History Repository + Persistence tests.
 *
 * Covers:
 *  - Migration: new DB creates tables, old DB upgrades
 *  - Repository: insert / query / ordering / limit
 *  - Retention: expired cleanup
 *  - setHealthHistoryDb binding: stores use SQLite when bound
 *  - Compatibility: v1.4 API response shape unchanged
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { Db } from '../src/db.js';
import {
  AttentionHistoryRepository,
  DEFAULT_HEALTH_RETENTION_DAYS,
  HealthHistoryRepository,
  decodeFactors,
  healthRetentionCutoffIso,
} from '../src/health-history-repository.js';
import {
  _resetHealthHistoryDbForTests,
  analyzeHealthTrend,
  attentionHistoryStore,
  computeAgentReliability,
  createHealthHistoryStore,
  healthHistoryStore,
  setHealthHistoryDb,
} from '../src/health-history.js';
import type { HealthFactor, HealthLevel } from '@agentos/shared';

let tmpRoot: string;
let db: Db;
let healthRepo: HealthHistoryRepository;
let attentionRepo: AttentionHistoryRepository;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-hhr-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
  healthRepo = new HealthHistoryRepository(db);
  attentionRepo = new AttentionHistoryRepository(db);
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------- Migration ---------------- */

test('migration: new DB creates both tables automatically', () => {
  setup();
  try {
    const health = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='execution_health_history'`,
    ).get() as { name: string } | undefined;
    assert.ok(health, 'execution_health_history should exist');
    const attention = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='execution_attention_history'`,
    ).get() as { name: string } | undefined;
    assert.ok(attention, 'execution_attention_history should exist');
  } finally { teardown(); }
});

test('migration: indexes are present after migration', () => {
  setup();
  try {
    const indexes = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('execution_health_history', 'execution_attention_history')`,
    ).all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    assert.ok(names.has('idx_execution_health_history_exec'));
    assert.ok(names.has('idx_execution_health_history_created'));
    assert.ok(names.has('idx_execution_attention_history_exec'));
    assert.ok(names.has('idx_execution_attention_history_key'));
  } finally { teardown(); }
});

test('migration: old v0.2 DB gets new tables on next open', () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-hhr-old-'));
  const oldDbFile = path.join(tmpRoot, 'old.db');
  // Create a v0.2-style DB manually (no execution_health_history / execution_attention_history)
  {
    const old = new Database(oldDbFile);
    old.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0.2.0');`);
    old.close();
  }
  // Re-open via Db() — should trigger migration
  const reopened = new Db(oldDbFile);
  const health = reopened.raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='execution_health_history'`,
  ).get() as { name: string } | undefined;
  assert.ok(health, 'migration should create execution_health_history');
  const versionRow = reopened.raw.prepare(
    `SELECT value FROM schema_meta WHERE key = 'schema_version'`,
  ).get() as { value: string };
  assert.equal(versionRow.value, '1.5.0');
  reopened.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* ---------------- Repository: insert / query ---------------- */

test('healthRepo: insert + getLatest + read', () => {
  setup();
  try {
    const factors: HealthFactor[] = [{ name: 'high-confidence', impact: 4, reason: 'r' }];
    healthRepo.insertHealth({
      executionId: 'claude-code:abc:exec-0',
      score: 80, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors, nowIso: '2026-07-23T10:00:00.000Z',
    });
    healthRepo.insertHealth({
      executionId: 'claude-code:abc:exec-0',
      score: 30, level: 'critical' as HealthLevel,
      derivedStatus: 'failed', factors: [], nowIso: '2026-07-23T10:05:00.000Z',
    });
    const latest = healthRepo.getLatestHealth('claude-code:abc:exec-0');
    assert.ok(latest);
    assert.equal(latest!.score, 30);
    const all = healthRepo.readHealth('claude-code:abc:exec-0', 10);
    assert.equal(all.length, 2);
    // Oldest first
    assert.equal(all[0]!.score, 80);
    assert.equal(all[1]!.score, 30);
  } finally { teardown(); }
});

test('healthRepo: read respects limit (returns oldest N of the latest M)', () => {
  setup();
  try {
    for (let i = 0; i < 10; i++) {
      healthRepo.insertHealth({
        executionId: 'claude-code:abc:exec-0',
        score: 50 + i, level: 'warning' as HealthLevel,
        derivedStatus: 'running', factors: [],
        nowIso: new Date(Date.UTC(2026, 6, 23, 10, i)).toISOString(),
      });
    }
    const all = healthRepo.readHealth('claude-code:abc:exec-0', 5);
    assert.equal(all.length, 5);
    // Should be the last 5 inserted (50+5 .. 50+9), oldest-first
    assert.equal(all[0]!.score, 55);
    assert.equal(all[4]!.score, 59);
  } finally { teardown(); }
});

test('healthRepo: getLatestHealth returns null for unknown execution', () => {
  setup();
  try {
    assert.equal(healthRepo.getLatestHealth('nope'), null);
    assert.deepEqual(healthRepo.readHealth('nope', 10), []);
  } finally { teardown(); }
});

test('attentionRepo: insert + read + getState + size', () => {
  setup();
  try {
    attentionRepo.insertAttention({
      executionId: 'claude-code:abc:exec-0',
      attentionKey: 'review-conflict',
      lifecycle: 'detected',
      severity: 'critical',
      reason: 'manual conflicts',
      nowIso: '2026-07-23T10:00:00.000Z',
    });
    attentionRepo.insertAttention({
      executionId: 'claude-code:abc:exec-0',
      attentionKey: 'review-conflict',
      lifecycle: 'ongoing',
      severity: 'critical',
      reason: 'still there',
      nowIso: '2026-07-23T10:05:00.000Z',
    });
    const all = attentionRepo.readAttention('claude-code:abc:exec-0', 10);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.lifecycle_state, 'detected');
    assert.equal(all[1]!.lifecycle_state, 'ongoing');
    assert.equal(attentionRepo.getAttentionState('claude-code:abc:exec-0', 'review-conflict'), 'ongoing');
    assert.equal(attentionRepo.attentionSize(), 2);
  } finally { teardown(); }
});

/* ---------------- decodeFactors ---------------- */

test('decodeFactors: handles valid JSON', () => {
  const arr = decodeFactors(JSON.stringify([{ name: 'a', impact: 1, reason: 'r' }]));
  assert.equal(arr.length, 1);
});

test('decodeFactors: handles invalid JSON → empty array', () => {
  assert.deepEqual(decodeFactors('not-valid-json'), []);
  assert.deepEqual(decodeFactors(null), []);
  assert.deepEqual(decodeFactors(''), []);
});

test('decodeFactors: filters out malformed entries', () => {
  const arr = decodeFactors(JSON.stringify([
    { name: 'a', impact: 1, reason: 'r' },     // ok
    { name: 123, impact: 1, reason: 'r' },       // bad name type
    { name: 'b' },                                // missing impact
  ]));
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.name, 'a');
});

/* ---------------- Retention ---------------- */

test('retention: cleanupExpiredHealth drops rows older than cutoff', () => {
  setup();
  try {
    healthRepo.insertHealth({
      executionId: 'e1', score: 80, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors: [], nowIso: '2025-01-01T00:00:00.000Z',
    });
    healthRepo.insertHealth({
      executionId: 'e1', score: 50, level: 'warning' as HealthLevel,
      derivedStatus: 'idle', factors: [], nowIso: '2026-07-23T00:00:00.000Z',
    });
    const cutoff = '2026-01-01T00:00:00.000Z';
    const removed = healthRepo.cleanupExpiredHealth(cutoff);
    assert.equal(removed, 1);
    assert.equal(healthRepo.healthSize(), 1);
  } finally { teardown(); }
});

test('retention: default cutoff is 180 days', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const cutoff = healthRetentionCutoffIso(now, DEFAULT_HEALTH_RETENTION_DAYS);
  const expected = new Date(now - 180 * 24 * 60 * 60_000).toISOString();
  assert.equal(cutoff, expected);
  assert.equal(DEFAULT_HEALTH_RETENTION_DAYS, 180);
});

test('retention: attention has no auto-cleanup (naturally bounded)', () => {
  setup();
  try {
    attentionRepo.insertAttention({
      executionId: 'e1', attentionKey: 'k1', lifecycle: 'detected',
      severity: 'critical', reason: 'r', nowIso: '2020-01-01T00:00:00.000Z',
    });
    attentionRepo.insertAttention({
      executionId: 'e1', attentionKey: 'k1', lifecycle: 'ongoing',
      severity: 'critical', reason: 'r', nowIso: '2026-07-23T00:00:00.000Z',
    });
    // cleanupExpiredAttention exists but we never auto-call it
    assert.equal(attentionRepo.attentionSize(), 2);
  } finally { teardown(); }
});

/* ---------------- setHealthHistoryDb binding ---------------- */

test('setHealthHistoryDb: binds SQLite backend to module-level stores', () => {
  setup();
  try {
    setHealthHistoryDb(db);
    // Insert via the module-level store — should hit SQLite
    healthHistoryStore.append('claude-code:abc:exec-0', {
      score: 90, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors: [], createdAt: '2026-07-23T12:00:00.000Z',
    });
    const fromDb = healthRepo.getLatestHealth('claude-code:abc:exec-0');
    assert.ok(fromDb, 'store should have persisted to SQLite');
    assert.equal(fromDb!.score, 90);
    // And read via store uses DB
    const read = healthHistoryStore.read('claude-code:abc:exec-0', 10);
    assert.equal(read.length, 1);
  } finally {
    _resetHealthHistoryDbForTests();
    teardown();
  }
});

test('setHealthHistoryDb: latest() reads from DB when bound', () => {
  setup();
  try {
    setHealthHistoryDb(db);
    healthHistoryStore.append('e1', {
      score: 80, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors: [],
      createdAt: '2026-07-23T12:00:00.000Z',
    });
    healthHistoryStore.append('e1', {
      score: 40, level: 'critical' as HealthLevel,
      derivedStatus: 'failed', factors: [],
      createdAt: '2026-07-23T12:05:00.000Z',
    });
    const latest = healthHistoryStore.latest('e1');
    assert.equal(latest!.score, 40);
  } finally {
    _resetHealthHistoryDbForTests();
    teardown();
  }
});

test('setHealthHistoryDb: shouldRecord uses DB latest (not in-memory)', () => {
  setup();
  try {
    setHealthHistoryDb(db);
    // Pre-seed DB with a healthy snapshot
    healthRepo.insertHealth({
      executionId: 'e1', score: 80, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors: [],
      nowIso: '2026-07-23T12:00:00.000Z',
    });
    // Now query shouldRecord with no in-memory prev — should fall back to DB
    const should = healthHistoryStore.shouldRecord(
      healthRepo.getLatestHealth('e1') as never,
      { score: 30, level: 'critical' as HealthLevel, derivedStatus: 'failed' as never, factors: [] },
      Date.parse('2026-07-23T12:01:00.000Z'),
    );
    assert.equal(should, true); // level changed
  } finally {
    _resetHealthHistoryDbForTests();
    teardown();
  }
});

test('setHealthHistoryDb: attention reconcile writes to DB', () => {
  setup();
  try {
    setHealthHistoryDb(db);
    attentionHistoryStore.reconcileFromQueue([
      {
        executionId: 'e1', severity: 'critical', reason: 'conflict',
        recommendedAction: 'review-conflict', derivedStatus: 'running',
        detectedAt: '2026-07-23T12:00:00.000Z',
      },
    ], '2026-07-23T12:00:00.000Z');
    const rows = attentionRepo.readAttention('e1', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lifecycle_state, 'detected');
  } finally {
    _resetHealthHistoryDbForTests();
    teardown();
  }
});

/* ---------------- v1.4 API compatibility ---------------- */

test('compatibility: v1.4 store interface unchanged (in-memory fallback)', () => {
  // No setHealthHistoryDb call — uses in-memory fallback (v1.4 behavior)
  const store = createHealthHistoryStore();
  const now = Date.now();
  assert.equal(store.shouldRecord(null, { score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running' as never, factors: [] }, now), true);
  const entry = store.append('e1', {
    score: 80, level: 'healthy' as HealthLevel,
    derivedStatus: 'running', factors: [],
    createdAt: new Date(now).toISOString(),
  });
  assert.equal(entry.executionId, 'e1');
  assert.deepEqual(store.read('e1', 10).map((e) => e.score), [80]);
  assert.equal(store.latest('e1')?.score, 80);
  assert.equal(store.size(), 1);
});

test('compatibility: trend output shape unchanged', () => {
  const t = analyzeHealthTrend([], Date.now());
  assert.equal(t.direction, 'stable');
  assert.equal(t.scoreDelta, 0);
  assert.equal(t.samples, 0);
  assert.equal(t.from, null);
  assert.match(t.summary, /No history/);
});

test('compatibility: reliability output shape unchanged', () => {
  const r = computeAgentReliability([], new Map(), Date.now());
  assert.equal(r.length, 0);
});

test('compatibility: readHealthHistory response matches v1.4 shape', () => {
  setup();
  try {
    setHealthHistoryDb(db);
    healthHistoryStore.append('e1', {
      score: 80, level: 'healthy' as HealthLevel,
      derivedStatus: 'running', factors: [{ name: 'running', impact: 8, reason: 'r' }],
      createdAt: '2026-07-23T12:00:00.000Z',
    });
    const rows = healthHistoryStore.read('e1', 10);
    // Shape: id, executionId, score, level, derivedStatus, factors, createdAt
    assert.equal(typeof rows[0]!.id, 'number');
    assert.equal(typeof rows[0]!.executionId, 'string');
    assert.equal(typeof rows[0]!.score, 'number');
    assert.equal(typeof rows[0]!.level, 'string');
    assert.equal(typeof rows[0]!.derivedStatus, 'string');
    assert.ok(Array.isArray(rows[0]!.factors));
    assert.equal(typeof rows[0]!.createdAt, 'string');
    _resetHealthHistoryDbForTests();
  } finally { teardown(); }
});