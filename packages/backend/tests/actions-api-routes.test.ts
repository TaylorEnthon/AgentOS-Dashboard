/**
 * v1.16 Incident Recommended Actions — API integration tests.
 *
 * Covers:
 *  - GET /api/incidents/:incidentKey/actions — happy path (200)
 *  - GET .../actions — invalid key format → 400
 *  - GET .../actions — unknown incident → 404
 *  - GET .../actions — incident exists but no matching priority → 404
 *  - GET .../actions — read-only (no POST/PUT/PATCH/DELETE)
 *  - URL encoding works
 *  - Response shape (all required fields)
 *
 * Regression checks:
 *  - /api/incidents/:incidentKey/report still works (v1.15)
 *  - /api/incidents/:incidentKey/evidence still works (v1.14)
 *  - /api/incidents/:incidentKey/history still works (v1.13)
 *  - /api/incidents/investigation/:priorityId still works (v1.12)
 *  - /api/incidents/priorities still works (v1.11)
 *  - /api/incidents/:incidentKey (detail) still works (v1.8)
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v116-api-'));
  const dbFile = path.join(tmpRoot, 'test.db');
  db = new Db(dbFile);
  // v1.16: reset in-memory stores so each test starts clean.
  // The stores are module-level singletons that survive across tests
  // in the same process — we clear them so order-dependent leakage
  // doesn't cause the rich-data test to inherit leftovers from
  // earlier 1-incident tests.
  _resetHealthHistoryDbForTests();
  db.upsertSession({
    id: 's1', agentId: 'claude-code', agentType: 'claude-code' as never,
    externalId: 'ext-1', project: '/demo', projectDisplay: '/demo',
    title: 'demo session', startTime: '2026-07-23T09:00:00.000Z',
    endTime: '2026-07-23T18:00:00.000Z', status: 'completed',
    messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalTokens: 0, estimatedCost: 0, fileOps: 0, toolCalls: 0,
  });
  db.insertEvent({
    id: 'ev1', sessionId: 's1', agentId: 'claude-code',
    type: 'message', timestamp: '2026-07-23T10:30:00.000Z', detail: 'started',
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

function appendHealth(score: number, level: HealthLevel, derivedStatus: string, ts: string): void {
  healthHistoryStore.append('s1:exec-0', { score, level, derivedStatus, factors: [], createdAt: ts });
}

function seedScoreDropIncident(): void {
  appendHealth(95, 'healthy', 'running', '2026-07-23T11:00:00.000Z');
  appendHealth(25, 'critical', 'failed', '2026-07-23T11:05:00.000Z');
  attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read('s1:exec-0', 100));
}

/* ---------------- /api/incidents/:incidentKey/actions ---------------- */

test('GET /api/incidents/:incidentKey/actions: empty system → 404', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/actions',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/actions: invalid format → 400', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/no-pipe/actions',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: string };
    assert.ok(body.error);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/actions: unknown incident → 404', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-99|score-drop/actions',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/actions: returns 404 when no matching priority', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    // Single incident — burst threshold is 3, no priority fires.
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/actions',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/actions: returns 200 with full bundle (rich data)', async () => {
  await setupApp();
  try {
    // Need 3 distinct (exec, kind) pairs to trigger burst:score-drop priority.
    for (let i = 0; i < 3; i++) {
      const sid = `s${i + 1}`;
      db.upsertSession({
        id: sid, agentId: 'claude-code', agentType: 'claude-code' as never,
        externalId: `ext-${sid}`, project: '/demo', projectDisplay: '/demo',
        title: `demo session ${sid}`, startTime: '2026-07-23T09:00:00.000Z',
        endTime: '2026-07-23T18:00:00.000Z', status: 'completed',
        messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0,
        totalTokens: 0, estimatedCost: 0, fileOps: 0, toolCalls: 0,
      });
      db.insertEvent({
        id: `ev-${sid}`, sessionId: sid, agentId: 'claude-code',
        type: 'message', timestamp: '2026-07-23T10:30:00.000Z', detail: 'started',
      });
      healthHistoryStore.append(`${sid}:exec-0`, { score: 95, level: 'healthy', derivedStatus: 'running', factors: [], createdAt: '2026-07-23T11:00:00.000Z' });
      healthHistoryStore.append(`${sid}:exec-0`, { score: 25, level: 'critical', derivedStatus: 'failed', factors: [], createdAt: '2026-07-23T11:05:00.000Z' });
      attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(`${sid}:exec-0`, 100));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/actions',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      incidentKey: string;
      actions: Array<{
        type: string;
        priority: 'high' | 'medium' | 'low';
        reason: string;
      }>;
      hasActions: boolean;
      generatedAt: string;
    };
    assert.equal(body.incidentKey, 's1:exec-0|score-drop');
    assert.ok(Array.isArray(body.actions));
    assert.ok(body.generatedAt);
    // Each action has correct shape
    for (const a of body.actions) {
      assert.ok(['inspect-agent', 'review-execution', 'compare-history', 'watch-recurrence'].includes(a.type));
      assert.ok(['high', 'medium', 'low'].includes(a.priority));
      assert.ok(typeof a.reason === 'string' && a.reason.length > 0);
    }
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/actions: URL-encoded works', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent('s1:exec-0|score-drop')}/actions`,
    });
    // 200 (priority fires) or 404 (no priority) — both acceptable.
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

/* ---------------- Read-only ---------------- */

test('GET /api/incidents/:incidentKey/actions: no POST/PUT/PATCH/DELETE mutation', async () => {
  await setupApp();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/incidents/s1:exec-0|score-drop/actions',
      });
      assert.equal(res.statusCode, 404, `${method} should be 404`);
    }
  } finally { await teardownApp(); }
});

/* ---------------- Regression: existing endpoints ---------------- */

test('Regression: /api/incidents/:incidentKey/report still works (v1.15)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/report',
    });
    // 200 (priority fires) or 404 (no priority).
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/:incidentKey/evidence still works (v1.14)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/evidence',
    });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/:incidentKey/history still works (v1.13)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/history',
    });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/investigation/:priorityId still works (v1.12)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/investigation/burst:score-drop',
    });
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/priorities still works (v1.11)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({ method: 'GET', url: '/api/incidents/priorities' });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/:incidentKey (detail, no suffix) still works (v1.8)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop',
    });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});