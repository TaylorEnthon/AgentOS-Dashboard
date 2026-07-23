/**
 * v1.7 API route integration tests for /api/incidents/* endpoints.
 *
 * Covers:
 *  - GET /api/incidents/summary — pure aggregation
 *  - GET /api/executions/:id/incidents — per-execution list
 *  - Compatibility: empty / unknown session returns [] / zero counts
 *  - Read-only: no SQL writes
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
  attentionHistoryStore,
  healthHistoryStore,
  setHealthHistoryDb,
} from '../src/health-history.js';
import type { HealthLevel } from '@agentos/shared';

let tmpRoot: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let db: Db;

async function setupApp(): Promise<void> {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v17-api-'));
  const dbFile = path.join(tmpRoot, 'test.db');
  db = new Db(dbFile);
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

/* ---------------- /api/incidents/summary ---------------- */

test('GET /api/incidents/summary: empty system returns zeros', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/incidents/summary' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { active: number; recovered: number; criticalCount: number; highCount: number };
    assert.equal(body.active, 0);
    assert.equal(body.recovered, 0);
    assert.equal(body.criticalCount, 0);
    assert.equal(body.highCount, 0);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/summary: detects anomalies and counts them', async () => {
  await setupApp();
  try {
    // Insert at least one activity_event so groupEventsIntoExecutions
    // creates one group and the route iterates over it.
    db.insertEvent({
      id: 'ev1',
      sessionId: 's1',
      agentId: 'claude-code',
      type: 'message',
      timestamp: '2026-07-23T10:30:00.000Z',
      detail: 'started',
    });
    // Force-detect via reconcileAnomalies (simulates /api/attention flow)
    appendHealth(95, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed',  '2026-07-23T11:00:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));

    const res = await app.inject({ method: 'GET', url: '/api/incidents/summary' });
    const body = res.json() as {
      active: number;
      criticalCount: number;
      highCount: number;
      topAffected: Array<{ executionId: string; activeCount: number; worstSeverity: 'high' | 'critical' }>;
      recentRecovered: unknown[];
      computedAt: string;
    };
    assert.ok(body.active >= 1, 'at least one active incident');
    assert.ok(body.criticalCount + body.highCount >= 1);
    assert.ok(body.topAffected.length >= 1);
    assert.equal(body.topAffected[0]!.executionId, EXEC);
    assert.ok(typeof body.computedAt === 'string');
  } finally { await teardownApp(); }
});

test('GET /api/incidents/summary: respects topAffectedLimit query param', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/summary?topAffectedLimit=1&recentRecoveredLimit=2',
    });
    const body = res.json() as { topAffected: unknown[]; recentRecovered: unknown[] };
    assert.ok(body.topAffected.length <= 1);
    assert.ok(body.recentRecovered.length <= 2);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/summary: invalid limit clamps to safe range', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/summary?topAffectedLimit=99999',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { topAffected: unknown[] };
    // Capped at 50 in route handler
    assert.ok(body.topAffected.length <= 50);
  } finally { await teardownApp(); }
});

/* ---------------- /api/executions/:id/incidents ---------------- */

test('GET /api/executions/:id/incidents: bad id returns []', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/executions/no_id/incidents' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await teardownApp(); }
});

test('GET /api/executions/:id/incidents: unknown session returns []', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/executions/unknown:exec-0/incidents` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await teardownApp(); }
});

test('GET /api/executions/:id/incidents: returns grouped incidents for the execution', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed',  '2026-07-23T11:00:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));
    const res = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/incidents` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Array<{
      executionId: string;
      kind: string;
      lifecycle: string;
      severity: string;
      detectedAt: string;
      incidentKey: string;
    }>;
    assert.ok(body.length >= 1);
    for (const inc of body) {
      assert.equal(inc.executionId, EXEC);
      assert.ok(['score-drop', 'level-regression', 'rapid-degradation'].includes(inc.kind));
      assert.ok(['detected', 'ongoing', 'recovered'].includes(inc.lifecycle));
    }
  } finally { await teardownApp(); }
});

/* ---------------- Read-only: route is GET-only ---------------- */

test('GET /api/incidents/summary: no POST/PUT/DELETE mutation routes exist', async () => {
  await setupApp();
  try {
    // POST/PUT/PATCH/DELETE should all 404 — the route is read-only.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/incidents/summary' });
      assert.equal(res.statusCode, 404, `${method} should be 404 (no mutation route)`);
    }
  } finally { await teardownApp(); }
});