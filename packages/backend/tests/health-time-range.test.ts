/**
 * v1.6 Repository time-range query tests.
 *
 * Covers:
 *  - readHealth(executionId, limit, { fromIso, toIso })
 *  - readAttention(executionId, limit, { fromIso, toIso })
 *  - v1.5 backward compatibility (no range → full result)
 *  - half-open interval semantics (from inclusive, to exclusive)
 *  - combined limit + range
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import {
  AttentionHistoryRepository,
  HealthHistoryRepository,
} from '../src/health-history-repository.js';
import type { HealthLevel } from '@agentos/shared';

let tmpRoot: string;
let db: Db;
let healthRepo: HealthHistoryRepository;
let attentionRepo: AttentionHistoryRepository;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v16-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
  healthRepo = new HealthHistoryRepository(db);
  attentionRepo = new AttentionHistoryRepository(db);
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------- Health readHealth with range ---------------- */

test('readHealth: no range returns all (v1.5 backward compat)', () => {
  setup();
  try {
    healthRepo.insertHealth({ executionId: 'e1', score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T10:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 60, level: 'warning' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T11:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 30, level: 'critical' as HealthLevel, derivedStatus: 'failed',  factors: [], nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = healthRepo.readHealth('e1', 100);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.score, 80);
    assert.equal(rows[2]!.score, 30);
  } finally { teardown(); }
});

test('readHealth: fromIso is inclusive', () => {
  setup();
  try {
    healthRepo.insertHealth({ executionId: 'e1', score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T10:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 60, level: 'warning' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T11:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 30, level: 'critical' as HealthLevel, derivedStatus: 'failed',  factors: [], nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = healthRepo.readHealth('e1', 100, { fromIso: '2026-07-23T11:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.score, 60);
    assert.equal(rows[1]!.score, 30);
  } finally { teardown(); }
});

test('readHealth: toIso is exclusive', () => {
  setup();
  try {
    healthRepo.insertHealth({ executionId: 'e1', score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T10:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 60, level: 'warning' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T11:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 30, level: 'critical' as HealthLevel, derivedStatus: 'failed',  factors: [], nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = healthRepo.readHealth('e1', 100, { toIso: '2026-07-23T12:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.score, 80);
    assert.equal(rows[1]!.score, 60);
  } finally { teardown(); }
});

test('readHealth: from + to yields half-open window', () => {
  setup();
  try {
    healthRepo.insertHealth({ executionId: 'e1', score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T10:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 60, level: 'warning' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T11:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 40, level: 'critical' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T12:00:00.000Z' });
    healthRepo.insertHealth({ executionId: 'e1', score: 20, level: 'critical' as HealthLevel, derivedStatus: 'failed',  factors: [], nowIso: '2026-07-23T13:00:00.000Z' });
    const rows = healthRepo.readHealth('e1', 100, { fromIso: '2026-07-23T11:00:00.000Z', toIso: '2026-07-23T13:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.score, 60);
    assert.equal(rows[1]!.score, 40);
  } finally { teardown(); }
});

test('readHealth: limit applied AFTER range filter (limit = newest N within range, oldest-first)', () => {
  setup();
  try {
    for (let i = 0; i < 10; i++) {
      healthRepo.insertHealth({
        executionId: 'e1', score: 100 - i * 5,
        level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [],
        nowIso: `2026-07-23T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
      });
    }
    // With limit=3 + fromIso=12:00, we get the 3 newest rows in the
    // [12:00, ∞) range, returned oldest-first.
    // Range rows: i=2 (90,12:00), i=3 (85,13:00), i=4 (80,14:00),
    //             i=5 (75,15:00), i=6 (70,16:00), i=7 (65,17:00),
    //             i=8 (60,18:00), i=9 (55,19:00)
    // Newest 3 by id: i=9 (55), i=8 (60), i=7 (65)
    // Reversed to oldest-first: 65, 60, 55
    const rows = healthRepo.readHealth('e1', 3, { fromIso: '2026-07-23T12:00:00.000Z' });
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.score, 65);
    assert.equal(rows[1]!.score, 60);
    assert.equal(rows[2]!.score, 55);
  } finally { teardown(); }
});

test('readHealth: range that matches nothing returns []', () => {
  setup();
  try {
    healthRepo.insertHealth({ executionId: 'e1', score: 80, level: 'healthy' as HealthLevel, derivedStatus: 'running', factors: [], nowIso: '2026-07-23T10:00:00.000Z' });
    const rows = healthRepo.readHealth('e1', 100, { fromIso: '2026-07-25T00:00:00.000Z' });
    assert.equal(rows.length, 0);
  } finally { teardown(); }
});

/* ---------------- Attention readAttention with range ---------------- */

test('readAttention: no range returns all (v1.5 backward compat)', () => {
  setup();
  try {
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'detected',  severity: 'critical', reason: 'r1', nowIso: '2026-07-23T10:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'ongoing',   severity: 'critical', reason: 'r2', nowIso: '2026-07-23T11:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'recovered', severity: 'low',      reason: 'r3', nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = attentionRepo.readAttention('e1', 100);
    assert.equal(rows.length, 3);
  } finally { teardown(); }
});

test('readAttention: fromIso is inclusive', () => {
  setup();
  try {
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'detected',  severity: 'critical', reason: 'r1', nowIso: '2026-07-23T10:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'ongoing',   severity: 'critical', reason: 'r2', nowIso: '2026-07-23T11:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'review-conflict', lifecycle: 'recovered', severity: 'low',      reason: 'r3', nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = attentionRepo.readAttention('e1', 100, { fromIso: '2026-07-23T11:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.lifecycle_state, 'ongoing');
    assert.equal(rows[1]!.lifecycle_state, 'recovered');
  } finally { teardown(); }
});

test('readAttention: toIso is exclusive', () => {
  setup();
  try {
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'detected',  severity: 'critical', reason: 'r1', nowIso: '2026-07-23T10:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'ongoing',   severity: 'critical', reason: 'r2', nowIso: '2026-07-23T11:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'recovered', severity: 'low',      reason: 'r3', nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = attentionRepo.readAttention('e1', 100, { toIso: '2026-07-23T12:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.lifecycle_state, 'detected');
    assert.equal(rows[1]!.lifecycle_state, 'ongoing');
  } finally { teardown(); }
});

test('readAttention: from + to yields half-open window', () => {
  setup();
  try {
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'detected',  severity: 'critical', reason: 'r1', nowIso: '2026-07-23T10:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'ongoing',   severity: 'critical', reason: 'r2', nowIso: '2026-07-23T11:00:00.000Z' });
    attentionRepo.insertAttention({ executionId: 'e1', attentionKey: 'k1', lifecycle: 'recovered', severity: 'low',      reason: 'r3', nowIso: '2026-07-23T12:00:00.000Z' });
    const rows = attentionRepo.readAttention('e1', 100, { fromIso: '2026-07-23T11:00:00.000Z', toIso: '2026-07-23T12:00:00.000Z' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lifecycle_state, 'ongoing');
  } finally { teardown(); }
});