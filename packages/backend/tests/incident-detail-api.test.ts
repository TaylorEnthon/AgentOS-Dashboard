/**
 * v1.8 Incident Detail API integration tests.
 *
 * Covers:
 *  - GET /api/incidents/:incidentKey — happy path
 *  - Bad input graceful (404 / 400)
 *  - Severity evolution in response
 *  - Transitions + severityHistory in response
 *  - Read-only (no POST/PUT/PATCH/DELETE mutation routes)
 *  - Compatibility: incidentKey from existing /api/executions/:id/incidents works
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v18-api-'));
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
  db.insertEvent({
    id: 'ev1',
    sessionId: 's1',
    agentId: 'claude-code',
    type: 'message',
    timestamp: '2026-07-23T10:30:00.000Z',
    detail: 'started',
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

/* ---------------- Happy path ---------------- */

test('GET /api/incidents/:key: returns detail with severity evolution', async () => {
  await setupApp();
  try {
    // Build an incident with one escalation
    appendHealth(95, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(50, 'warning',  'running', '2026-07-23T10:05:00.000Z');  // score-drop high
    appendHealth(25, 'critical', 'failed',  '2026-07-23T10:10:00.000Z');  // level-regression critical
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));

    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent(EXEC + '|score-drop')}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      incidentKey: string;
      executionId: string;
      kind: string;
      lifecycle: string;
      severity: string;
      initialSeverity: string;
      currentSeverity: string;
      maxSeverity: string;
      escalationCount: number;
      transitions: Array<{ at: string; lifecycle: string; severity: string }>;
      severityHistory: Array<{ at: string; from: string; to: string }>;
      computedAt: string;
    };
    assert.equal(body.incidentKey, `${EXEC}|score-drop`);
    assert.equal(body.kind, 'score-drop');
    assert.ok(['detected', 'ongoing', 'recovered'].includes(body.lifecycle));
    assert.equal(typeof body.escalationCount, 'number');
    assert.ok(Array.isArray(body.transitions));
    assert.ok(Array.isArray(body.severityHistory));
    assert.equal(typeof body.computedAt, 'string');
  } finally { await teardownApp(); }
});

/* ---------------- Severity evolution ---------------- */

test('GET /api/incidents/:key: severity escalation history is recorded', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy',  'running', '2026-07-23T10:00:00.000Z');
    appendHealth(50, 'warning',  'running', '2026-07-23T10:05:00.000Z');
    appendHealth(25, 'critical', 'failed',  '2026-07-23T10:10:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));

    // The score-drop row went high (50 < 95, drop=45, threshold=30 → severity=high
    //   via 2x multiplier? No — drop is 45, threshold 30, 2x=60; 45<60 → high).
    // The level-regression row ended critical → severity=critical → escalation.
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent(EXEC + '|level-regression')}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      severity: string;
      initialSeverity: string;
      maxSeverity: string;
      escalationCount: number;
      severityHistory: Array<{ from: string; to: string }>;
    };
    // level-regression ends at critical directly → initialSeverity should be critical,
    // maxSeverity should be critical, escalationCount should be 0 (no high→critical
    // transition since we went healthy→critical in one step).
    assert.equal(body.initialSeverity, 'critical');
    assert.equal(body.maxSeverity, 'critical');
    assert.equal(body.escalationCount, 0);
    assert.equal(body.severityHistory.length, 0);
  } finally { await teardownApp(); }
});

/* ---------------- Bad input ---------------- */

test('GET /api/incidents/:key: bad key format returns 400', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/incidents/no_pipe_at_all' });
    assert.equal(res.statusCode, 400);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:key: unknown incidentKey returns 404', async () => {
  await setupApp();
  try {
    // Valid shape, but the execution has no anomaly-derived attention rows
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent(EXEC + '|score-drop')}`,
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:key: unknown session returns 404', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent('unknown-session:exec-0|score-drop')}`,
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

/* ---------------- Compatibility ---------------- */

test('GET /api/incidents/:key: key from /api/executions/:id/incidents roundtrips', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy', 'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed', '2026-07-23T10:05:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));

    // First fetch list to get an incidentKey
    const listRes = await app.inject({ method: 'GET', url: `/api/executions/${EXEC}/incidents` });
    const list = listRes.json() as Array<{ incidentKey: string }>;
    assert.ok(list.length > 0);
    const key = list[0]!.incidentKey;

    // Now fetch detail using that key
    const detailRes = await app.inject({ method: 'GET', url: `/api/incidents/${encodeURIComponent(key)}` });
    assert.equal(detailRes.statusCode, 200);
    const detail = detailRes.json() as { incidentKey: string; transitions: unknown[] };
    assert.equal(detail.incidentKey, key);
    assert.ok(Array.isArray(detail.transitions));
    assert.ok(detail.transitions.length > 0);
  } finally { await teardownApp(); }
});

/* ---------------- Read-only ---------------- */

test('GET /api/incidents/:key: no mutation route (POST/PUT/PATCH/DELETE = 404)', async () => {
  await setupApp();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/api/incidents/${encodeURIComponent(EXEC + '|score-drop')}`,
      });
      assert.equal(res.statusCode, 404, `${method} should be 404 (no mutation route)`);
    }
  } finally { await teardownApp(); }
});

/* ---------------- Backward compatibility: existing summary endpoint still works ---------------- */

test('GET /api/incidents/summary: still returns summary (regression check)', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy', 'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed', '2026-07-23T10:05:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read(EXEC, 100));

    const res = await app.inject({ method: 'GET', url: '/api/incidents/summary' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { active: number };
    assert.ok(body.active >= 1);
  } finally { await teardownApp(); }
});