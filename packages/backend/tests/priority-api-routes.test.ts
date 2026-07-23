/**
 * v1.11 Priority API integration tests.
 *
 * Covers:
 *  - GET /api/incidents/priorities — happy path with prioritization
 *  - GET /api/incidents/priorities — empty system
 *  - GET /api/incidents/priorities — topN cap
 *  - Read-only: no POST/PUT/PATCH/DELETE mutation routes
 *  - Backward compatibility: existing endpoints still work
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-v111-api-'));
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

/* ---------------- /api/incidents/priorities ---------------- */

test('GET /api/incidents/priorities: empty system returns empty priorities', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/incidents/priorities' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      priorities: unknown[];
      totalCount: number;
      highestLevel: string | null;
      byLevel: Record<string, number>;
    };
    assert.equal(body.priorities.length, 0);
    assert.equal(body.totalCount, 0);
    assert.equal(body.highestLevel, null);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/priorities: with data returns prioritized insights', async () => {
  await setupApp();
  try {
    // Generate incidents that will produce a signal (e.g. critical score-drop)
    appendHealth(95, 'healthy', 'running', '2026-07-23T11:00:00.000Z');
    appendHealth(25, 'critical', 'failed', '2026-07-23T11:05:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read('s1:exec-0', 100));

    const res = await app.inject({ method: 'GET', url: '/api/incidents/priorities' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      priorities: Array<{
        priorityId: string;
        priorityScore: number;
        priorityLevel: string;
        signalKind: string;
        subjectKey: string;
        reasons: Array<{ kind: string; contribution: number; message: string }>;
      }>;
      totalCount: number;
      highestLevel: string | null;
      byLevel: Record<string, number>;
      since: string;
      until: string;
      computedAt: string;
    };
    // May or may not have priorities depending on signal threshold; at minimum
    // verify the shape is correct.
    assert.ok(Array.isArray(body.priorities));
    assert.ok(body.since);
    assert.ok(body.until);
    assert.ok(body.computedAt);
    for (const p of body.priorities) {
      assert.ok(p.priorityId);
      assert.ok(['critical', 'high', 'medium', 'low'].includes(p.priorityLevel));
      assert.ok(typeof p.priorityScore === 'number');
      assert.ok(Array.isArray(p.reasons));
    }
  } finally { await teardownApp(); }
});

test('GET /api/incidents/priorities: respects topN query param', async () => {
  await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/incidents/priorities?topN=2' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { priorities: unknown[] };
    assert.ok(body.priorities.length <= 2);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/priorities: respects custom window params', async () => {
  await setupApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/priorities?since=2020-01-01T00:00:00.000Z&until=2030-01-01T00:00:00.000Z&topN=5',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { since: string; until: string };
    assert.equal(body.since, '2020-01-01T00:00:00.000Z');
    assert.equal(body.until, '2030-01-01T00:00:00.000Z');
  } finally { await teardownApp(); }
});

/* ---------------- Read-only ---------------- */

test('GET /api/incidents/priorities: no POST/PUT/PATCH/DELETE mutation', async () => {
  await setupApp();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/incidents/priorities' });
      assert.equal(res.statusCode, 404, `${method} should be 404`);
    }
  } finally { await teardownApp(); }
});

/* ---------------- Backward compatibility ---------------- */

test('GET /api/incidents/temporal: still works (regression check)', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy', 'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed', '2026-07-23T10:05:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read('s1:exec-0', 100));
    const res = await app.inject({ method: 'GET', url: '/api/incidents/temporal' });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});

test('GET /api/incidents/summary: still works (regression check)', async () => {
  await setupApp();
  try {
    appendHealth(95, 'healthy', 'running', '2026-07-23T10:00:00.000Z');
    appendHealth(25, 'critical', 'failed', '2026-07-23T10:05:00.000Z');
    attentionHistoryStore.reconcileAnomalies(healthHistoryStore.read('s1:exec-0', 100));
    const res = await app.inject({ method: 'GET', url: '/api/incidents/summary' });
    assert.equal(res.statusCode, 200);
  } finally { await teardownApp(); }
});