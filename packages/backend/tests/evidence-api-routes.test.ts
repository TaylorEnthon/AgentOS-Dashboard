/**
 * v1.14 Incident Root Cause Evidence — API integration tests.
 *
 * Covers:
 *  - GET /api/incidents/:incidentKey/evidence — happy path (200)
 *  - GET .../evidence — invalid key format → 400
 *  - GET .../evidence — unknown incident → 404
 *  - GET .../evidence — read-only (no POST/PUT/PATCH/DELETE)
 *  - URL encoding works
 *  - Response shape (all required fields)
 *
 * Regression checks:
 *  - /api/incidents/priorities still works
 *  - /api/incidents/investigation/:priorityId still works
 *  - /api/incidents/:incidentKey/history still works
 *  - /api/incidents/:incidentKey (detail, no suffix) still works
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v114-api-'));
  const dbFile = path.join(tmpRoot, 'test.db');
  db = new Db(dbFile);
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

/* ---------------- /api/incidents/:incidentKey/evidence ---------------- */

test('GET /api/incidents/:incidentKey/evidence: empty system → 404', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/evidence',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/evidence: invalid format → 400', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/no-pipe/evidence',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: string };
    assert.ok(body.error);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/evidence: unknown incident → 404', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-99|score-drop/evidence',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/evidence: returns full evidence bundle', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/evidence',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      incidentKey: string;
      executionId: string;
      kind: string;
      evidence: Array<{ kind: string; message: string; confidence: number; weight: number }>;
      confidence: number;
      hasEvidence: boolean;
      computedAt: string;
    };
    assert.equal(body.incidentKey, 's1:exec-0|score-drop');
    assert.equal(body.executionId, 's1:exec-0');
    assert.equal(body.kind, 'score-drop');
    assert.ok(Array.isArray(body.evidence));
    // Single incident: only severity evidence should fire
    assert.ok(body.evidence.length >= 1);
    const kinds = body.evidence.map((e) => e.kind);
    assert.ok(kinds.includes('severity'));
    // Every evidence item has the right shape
    for (const e of body.evidence) {
      assert.ok(typeof e.message === 'string');
      assert.ok(e.confidence >= 0 && e.confidence <= 1);
      assert.ok(e.weight >= 0 && e.weight <= 1);
    }
    assert.equal(body.confidence, body.evidence.reduce((m, e) => Math.max(m, e.confidence), 0));
    assert.ok(body.computedAt);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/evidence: URL-encoded works', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent('s1:exec-0|score-drop')}/evidence`,
    });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

/* ---------------- Read-only ---------------- */

test('GET /api/incidents/:incidentKey/evidence: no POST/PUT/PATCH/DELETE mutation', async () => {
  await setupApp();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/incidents/s1:exec-0|score-drop/evidence',
      });
      assert.equal(res.statusCode, 404, `${method} should be 404`);
    }
  } finally { await teardownApp(); }
});

/* ---------------- Regression: existing endpoints ---------------- */

test('Regression: /api/incidents/priorities still works', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({ method: 'GET', url: '/api/incidents/priorities' });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/investigation/:priorityId still works', async () => {
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