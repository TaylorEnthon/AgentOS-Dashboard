/**
 * v1.6 API route integration tests for health/attention history endpoints.
 *
 * Covers:
 *  - GET /api/executions/:id/health/history?from=&to=
 *  - GET /api/executions/:id/health/trend?from=&to=
 *  - GET /api/executions/:id/attention/history?from=&to=
 *  - GET /api/executions/:id/health/anomalies
 *  - v1.5 backward compatibility (no from/to → identical response)
 *  - Bad input (no :exec- in id) returns [] (graceful)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Fastify from 'fastify';
import { Db } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { Scheduler } from '../src/scheduler.js';
import { registerRoutes } from '../src/routes.js';
import {
  _resetHealthHistoryDbForTests,
  healthHistoryStore,
  setHealthHistoryDb,
} from '../src/health-history.js';
import type { HealthLevel } from '@agentos/shared';

let tmpRoot: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let db: Db;

async function setupApp(): Promise<void> {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v16-api-'));
  const dbFile = path.join(tmpRoot, 'test.db');
  db = new Db(dbFile);
  // Pre-seed one session so the routes accept the executionId
  db.upsertSession({
    id: 's1',
    agentId: 'claude-code',
    agentType: 'claude-code' as never,
    externalId: 'ext-1',
    project: '/demo',
    projectDisplay: '/demo',
    title: 'demo session',
    startTime: '2026-07-23T09:00:00.000Z',
    endTime: '2026-07-23T18:00:00.000Z',
    status: 'completed',
    messageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    fileOps: 0,
    toolCalls: 0,
  });
  const settings = new SettingsStore(db, path.join(tmpRoot, 'settings.json'));
  await settings.load();
  const scheduler = new Scheduler(db, settings);
  setHealthHistoryDb(db);
  app = Fastify({ disableRequestLogging: true });
  registerRoutes(app, db, scheduler, settings);
  await app.ready();
}

async function teardownApp(): Promise<void> {
  try { await app.close(); db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetHealthHistoryDbForTests();
}

const EXEC = 's1:exec-0';

function appendHealth(score: number, level: HealthLevel, derivedStatus: string, ts: string): void {
  healthHistoryStore.append(EXEC, { score, level, derivedStatus, factors: [], createdAt: ts });
}

/* ---------------- v1.5 backward compat ---------------- */

test('GET /health/history: no params (v1.5 behavior) returns full list', async () => {
  await setupApp();
  try {
    appendHealth(80, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(50, 'warning',  'running', '2026-07-23T11:00:00.000Z');
    appendHealth(20, 'critical', 'failed',  '2026-07-23T12:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/health/history` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Array<{ score: number; createdAt: string }>;
    assert.equal(body.length, 3);
    // oldest-first (consistent with v1.5)
    assert.equal(body[0]!.score, 80);
    assert.equal(body[2]!.score, 20);
  } finally { await teardownApp(); }
});

test('GET /health/history: ?limit=1 honored', async () => {
  await setupApp();
  try {
    appendHealth(80, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(50, 'warning',  'running', '2026-07-23T11:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/health/history?limit=1` });
    const body = res.json() as Array<{ score: number }>;
    assert.equal(body.length, 1);
  } finally { await teardownApp(); }
});

/* ---------------- v1.6 from/to ---------------- */

test('GET /health/history: ?from=&to= narrows the window', async () => {
  await setupApp();
  try {
    appendHealth(80, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(60, 'warning',  'running', '2026-07-23T11:00:00.000Z');
    appendHealth(40, 'warning',  'running', '2026-07-23T12:00:00.000Z');
    appendHealth(20, 'critical', 'failed',  '2026-07-23T13:00:00.000Z');
    const res = await app.inject({
      method: 'GET',
      url: `/api/executions/${EXEC}/health/history?from=2026-07-23T11:00:00.000Z&to=2026-07-23T13:00:00.000Z`,
    });
    const body = res.json() as Array<{ score: number; createdAt: string }>;
    assert.equal(body.length, 2);
    assert.equal(body[0]!.score, 60);
    assert.equal(body[1]!.score, 40);
  } finally { await teardownApp(); }
});

test('GET /health/history: bad executionId returns [] (graceful)', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/executions/not_a_real_id/health/history` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await teardownApp(); }
});

test('GET /health/history: unknown session returns []', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/executions/nonexistent:exec-0/health/history` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await teardownApp(); }
});

/* ---------------- v1.6 attention time range ---------------- */

test('GET /attention/history: ?from=&to= works', async () => {
  await setupApp();
  try {
    appendHealth(80, 'healthy', 'running', '2026-07-23T10:00:00.000Z'); // need at least one health row so ATTN becomes interesting
    const { attentionHistoryStore } = await import('../src/health-history.js');
    attentionHistoryStore.reconcileFromQueue([
      {
        executionId: EXEC, severity: 'critical', reason: 'conflict',
        recommendedAction: 'review-conflict', derivedStatus: 'running',
        detectedAt: '2026-07-23T10:00:00.000Z',
      },
    ], '2026-07-23T10:00:00.000Z');
    attentionHistoryStore.reconcileFromQueue([
      {
        executionId: EXEC, severity: 'critical', reason: 'conflict',
        recommendedAction: 'review-conflict', derivedStatus: 'running',
        detectedAt: '2026-07-23T13:00:00.000Z',
      },
    ], '2026-07-23T13:00:00.000Z');

    const res = await app.inject({
      method: 'GET',
      url: `/api/executions/${EXEC}/attention/history?from=2026-07-23T12:00:00.000Z`,
    });
    const body = res.json() as Array<{ createdAt: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]!.createdAt, '2026-07-23T13:00:00.000Z');
  } finally { await teardownApp(); }
});

/* ---------------- v1.6 /health/anomalies ---------------- */

test('GET /health/anomalies: detects score-drop and level-regression', async () => {
  await setupApp();
  try {
    appendHealth(90, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(30, 'critical', 'failed',  '2026-07-23T11:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/health/anomalies` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Array<{ kind: string; severity: string; message: string }>;
    const kinds = body.map((a) => a.kind).sort();
    assert.ok(kinds.includes('score-drop'));
    assert.ok(kinds.includes('level-regression'));
    // Both should be critical severity since drop is large and level ends critical
    for (const a of body) {
      assert.ok(a.severity === 'high' || a.severity === 'critical');
      assert.ok(typeof a.message === 'string' && a.message.length > 0);
    }
  } finally { await teardownApp(); }
});

test('GET /health/anomalies: stable history returns []', async () => {
  await setupApp();
  try {
    appendHealth(80, 'healthy', 'running', '2026-07-23T10:00:00.000Z');
    appendHealth(82, 'healthy', 'running', '2026-07-23T11:00:00.000Z');
    appendHealth(78, 'healthy', 'running', '2026-07-23T12:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/health/anomalies` });
    const body = res.json() as unknown[];
    assert.equal(body.length, 0);
  } finally { await teardownApp(); }
});

test('GET /health/anomalies: bad executionId returns [] (graceful)', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/executions/no_id/health/anomalies` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await teardownApp(); }
});

test('GET /health/trend: ?from=&to= narrows the analysis window', async () => {
  await setupApp();
  try {
    appendHealth(90, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(60, 'warning',  'running', '2026-07-23T11:00:00.000Z');
    appendHealth(20, 'critical', 'failed',  '2026-07-23T12:00:00.000Z');
    // Half-open [from, to): from=11:00 inclusive, to=12:00 exclusive → only 11:00 sample.
    const res = await app.inject({
      method: 'GET',
      url: `/api/executions/${EXEC}/health/trend?from=2026-07-23T11:00:00.000Z&to=2026-07-23T12:00:00.000Z`,
    });
    const body = res.json() as { samples: number; scoreDelta: number; direction: string };
    assert.equal(body.samples, 1);
    assert.equal(body.scoreDelta, 0); // single sample = no delta
    // Larger window includes both 11:00 and 12:00 samples → 2 samples, drop -40
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/executions/${EXEC}/health/trend?from=2026-07-23T11:00:00.000Z&to=2026-07-23T13:00:00.000Z`,
    });
    const body2 = res2.json() as { samples: number; scoreDelta: number; direction: string };
    assert.equal(body2.samples, 2);
    assert.equal(body2.scoreDelta, -40);
    assert.equal(body2.direction, 'degrading');
  } finally { await teardownApp(); }
});