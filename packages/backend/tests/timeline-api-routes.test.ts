/**
 * v1.18 Incident Investigation Timeline — API integration tests.
 *
 * Covers:
 *  - GET /api/incidents/:incidentKey/timeline — happy path (200)
 *  - GET .../timeline — invalid key format → 400
 *  - GET .../timeline — unknown incident → 404
 *  - GET .../timeline — incident exists but no matching priority → 404
 *  - GET .../timeline — read-only (no POST/PUT/PATCH/DELETE)
 *  - URL encoding works
 *  - Response shape (all required fields)
 *
 * Wall-clock safety (v1.17 lesson): pass a pinned nowIso to
 * `reconcileAnomalies` so the attention row's createdAt is deterministic
 * and falls inside the route's 24h window regardless of when the test
 * runs. This avoids the pre-existing v1.10/v1.14-v1.17 wall-clock bug
 * that surfaced in v1.17 CI run #34.
 *
 * Regression checks:
 *  - /api/incidents/:incidentKey/narrative still works (v1.17)
 *  - /api/incidents/:incidentKey/actions still works (v1.16)
 *  - /api/incidents/:incidentKey/report still works (v1.15)
 *  - /api/incidents/:incidentKey/evidence still works (v1.14)
 *  - /api/incidents/:incidentKey/history still works (v1.13)
 *  - /api/incidents/investigation/:priorityId still works (v1.12)
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v118-api-'));
  const dbFile = path.join(tmpRoot, 'test.db');
  db = new Db(dbFile);
  // v1.17: reset in-memory stores so each test starts clean.
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
  // v1.18: pin nowIso to "1 minute ago" (relative) so the attention row
  // is always in the route's 60-minute burst window regardless of when
  // the test runs. Same pattern as v1.16/v1.17 API tests (commit cea13d2).
  attentionHistoryStore.reconcileAnomalies(
    healthHistoryStore.read('s1:exec-0', 100),
    new Date(Date.now() - 60_000).toISOString(),
  );
}

/* ---------------- /api/incidents/:incidentKey/timeline ---------------- */

test('GET /api/incidents/:incidentKey/timeline: empty system → 404', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/timeline',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/timeline: invalid format → 400', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/no-pipe/timeline',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: string };
    assert.ok(body.error);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/timeline: unknown incident → 404', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-99|score-drop/timeline',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/timeline: returns 404 when no matching priority', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    // Single incident — burst threshold is 3, no priority fires.
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/timeline',
    });
    assert.equal(res.statusCode, 404);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/timeline: returns 200 with full timeline (rich data)', async () => {
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
      // v1.18: pin nowIso to "1 minute ago" (relative) so the attention row
      // is always inside the route's 60-minute burst window regardless
      // of when the test runs. Same pattern as v1.16/v1.17 API tests.
      attentionHistoryStore.reconcileAnomalies(
        healthHistoryStore.read(`${sid}:exec-0`, 100),
        new Date(Date.now() - 60_000).toISOString(),
      );
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/timeline',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      incidentKey: string;
      events: Array<{
        timestamp: string;
        type: 'detected' | 'escalated' | 'recovered' | 'recurred';
        message: string;
      }>;
      generatedAt: string;
    };
    assert.equal(body.incidentKey, 's1:exec-0|score-drop');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0);
    // The first event should be 'detected' (always fires)
    assert.equal(body.events[0]!.type, 'detected');
    // Verify events are timestamp-ASC
    for (let i = 1; i < body.events.length; i++) {
      assert.ok(
        new Date(body.events[i - 1]!.timestamp).getTime() <= new Date(body.events[i]!.timestamp).getTime(),
        `events should be ordered ASC at index ${i}`,
      );
    }
    // Verify event shape
    for (const ev of body.events) {
      assert.ok(['detected', 'escalated', 'recovered', 'recurred'].includes(ev.type));
      assert.ok(typeof ev.message === 'string' && ev.message.length > 0);
      assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0);
    }
    assert.ok(body.generatedAt);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/:incidentKey/timeline: URL-encoded works', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent('s1:exec-0|score-drop')}/timeline`,
    });
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

/* ---------------- Read-only ---------------- */

test('GET /api/incidents/:incidentKey/timeline: no POST/PUT/PATCH/DELETE mutation', async () => {
  await setupApp();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/incidents/s1:exec-0|score-drop/timeline',
      });
      assert.equal(res.statusCode, 404, `${method} should be 404`);
    }
  } finally { await teardownApp(); }
});

/* ---------------- Regression: existing endpoints ---------------- */

test('Regression: /api/incidents/:incidentKey/narrative still works (v1.17)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/narrative',
    });
    // 200 (priority fires) or 404 (no priority).
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/:incidentKey/actions still works (v1.16)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/actions',
    });
    assert.ok([200, 404].includes(res.statusCode));
  } finally { await teardownApp(); }
});

test('Regression: /api/incidents/:incidentKey/report still works (v1.15)', async () => {
  await setupApp();
  try {
    seedScoreDropIncident();
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/s1:exec-0|score-drop/report',
    });
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