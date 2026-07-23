import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import type { AgentSession, UsageRecord, ActivityEvent } from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-db-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('agent upsert + list roundtrip', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
    db.upsertAgent({ id: 'codex', name: 'Codex', type: 'codex', dataDir: '/y', enabled: false });
    const agents = db.listAgents();
    assert.equal(agents.length, 2);
    assert.equal(agents.find((a) => a.id === 'claude-code')!.enabled, 1);
    assert.equal(agents.find((a) => a.id === 'codex')!.enabled, 0);
  } finally { teardown(); }
});

test('session upsert is idempotent and accumulates totals on update', () => {
  setup();
  try {
    const s: AgentSession = {
      id: 'claude-code:a',
      agentId: 'claude-code',
      agentType: 'claude-code',
      externalId: 'a',
      project: '/p',
      projectDisplay: '/p',
      startTime: '2026-07-22T10:00:00.000Z',
      endTime: '2026-07-22T10:01:00.000Z',
      status: 'completed',
      model: 'claude-sonnet-4',
      messageCount: 3,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      estimatedCost: 0.0001,
      fileOps: 1,
      toolCalls: 1,
    };
    db.upsertSession(s);
    db.upsertSession({ ...s, messageCount: 5, totalInputTokens: 200 });
    const stored = db.listSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].message_count, 5);
    assert.equal(stored[0].total_input_tokens, 200);
  } finally { teardown(); }
});

test('usage and event insert are idempotent via primary key', () => {
  setup();
  try {
    db.upsertSession(makeSession('s', '2026-07-22T10:00:00Z', 'completed', 1, 1, 0));
    const u: UsageRecord = {
      id: 'u-1', sessionId: 'claude-code:s', agentId: 'claude-code', model: 'm',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 15, estimatedCost: 0, timestamp: '2026-07-22T10:00:00Z',
      usageConfidence: 'exact', costConfidence: 'exact', unknownModel: false,
    };
    const e: ActivityEvent = {
      id: 'e-1', sessionId: 'claude-code:s', agentId: 'claude-code', type: 'message',
      timestamp: '2026-07-22T10:00:00Z', detail: 'hello',
    };
    db.insertUsage(u); db.insertUsage(u);
    db.insertEvent(e); db.insertEvent(e);
    assert.equal(db.listUsageForSession('claude-code:s').length, 1);
    assert.equal(db.listEventsForSession('claude-code:s').length, 1);
  } finally { teardown(); }
});

test('overview aggregates correctly', () => {
  setup();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    db.upsertSession(makeSession('s1', `${today}T10:00:00Z`, 'completed', 100, 50, 0.5));
    db.upsertSession(makeSession('s2', `${today}T11:00:00Z`, 'running',   200, 80, 0.7));
    db.upsertSession(makeSession('s3', `${yesterday}T10:00:00Z`, 'completed', 50,  10, 0.1));
    const ov = db.overview();
    assert.equal(ov.totalSessions, 3);
    assert.equal(ov.activeSessions, 1);
    assert.equal(ov.todaySessions, 2);
    assert.equal(ov.todayTokens, 100+50+200+80);
    assert.ok(Math.abs(ov.totalCost - 1.3) < 0.0001);
    assert.equal(ov.byAgent.length, 1);
  } finally { teardown(); }
});

test('projects list aggregates per project', () => {
  setup();
  try {
    db.upsertProject({ path: '/p', displayName: '/p', lastSeen: '2026-07-22T10:00:00Z' });
    db.upsertSession(makeSession('a', '2026-07-22T10:00:00Z', 'completed', 100, 50, 0.5));
    const projects = db.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].totalTokens, 150);
    assert.equal(projects[0].sessionCount, 1);
  } finally { teardown(); }
});

test('settings roundtrip', () => {
  setup();
  try {
    db.setSetting('foo', 'bar');
    assert.equal(db.getSetting('foo'), 'bar');
    db.setSetting('foo', 'baz');
    assert.equal(db.getSetting('foo'), 'baz');
    db.deleteSetting('foo');
    assert.equal(db.getSetting('foo'), undefined);
  } finally { teardown(); }
});

/* -------------------- v0.2: provenance, confidence, ingestion_files, migration -------------------- */

test('session upsert persists provenance + confidence', () => {
  setup();
  try {
    db.upsertSession({
      ...makeSession('s1', '2026-07-22T10:00:00Z', 'completed', 100, 50, 0.5),
      usageConfidence: 'exact',
      costConfidence: 'estimated',
      source: {
        sourceFile: '/tmp/s.jsonl',
        sourceProvider: 'claude-code',
        sourceId: 's1',
        collectedAt: '2026-07-22T10:00:00Z',
      },
    });
    const stored = db.getSession('s1');
    assert.ok(stored);
    assert.equal(stored!.usage_confidence, 'exact');
    assert.equal(stored!.cost_confidence, 'estimated');
    assert.equal(stored!.source_file, '/tmp/s.jsonl');
    assert.equal(stored!.source_id, 's1');
    assert.equal(stored!.collected_at, '2026-07-22T10:00:00Z');
  } finally { teardown(); }
});

test('insertUsage returns true on insert, false on duplicate; stamps confidence', () => {
  setup();
  try {
    db.upsertSession(makeSession('s', '2026-07-22T10:00:00Z', 'completed', 0, 0, 0));
    const u: UsageRecord = {
      id: 'u-1', sessionId: 'claude-code:s', agentId: 'claude-code', model: 'claude-sonnet-4',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 15, estimatedCost: 0, timestamp: '2026-07-22T10:00:00Z',
      usageConfidence: 'exact', costConfidence: 'exact', unknownModel: false,
      source: { sourceFile: '/tmp/s.jsonl', sourceProvider: 'claude-code', sourceId: 'u-1', collectedAt: '2026-07-22T10:00:00Z' },
    };
    assert.equal(db.insertUsage(u), true);  // new
    assert.equal(db.insertUsage(u), false); // dedup
    const stored = db.listUsageForSession('claude-code:s')[0];
    assert.equal(stored.usage_confidence, 'exact');
    assert.equal(stored.cost_confidence, 'exact');
    assert.equal(stored.unknown_model, 0);
    assert.equal(stored.source_file, '/tmp/s.jsonl');
  } finally { teardown(); }
});

test('migration is idempotent (re-running constructor does not duplicate)', () => {
  setup();
  try {
    db.upsertSession(makeSession('s', '2026-07-22T10:00:00Z', 'completed', 1, 1, 0));
    db.close();
    db = new Db(path.join(tmpRoot, 'test.db'));
    // column still present + values still readable
    const rows = db.listSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_input_tokens, 1);
    // re-running migrate() on a v0.2 DB is a no-op
    (db as any).migrate();
    (db as any).migrate();
    assert.equal(db.listSessions().length, 1);
  } finally { teardown(); }
});

test('ingestion_files recordIngestionFile + priorFileMap + dedup overwritten per scan', () => {
  setup();
  try {
    db.recordIngestionFile({
      provider: 'claude-code', filePath: '/tmp/x.jsonl',
      size: 100, mtimeMs: 1700000000000, contentHash: 'h1',
      inserted: 10, duplicatesPrevented: 2,
      sessions: 1, usageRecords: 10, events: 5,
    });
    db.recordIngestionFile({
      provider: 'claude-code', filePath: '/tmp/x.jsonl',
      size: 105, mtimeMs: 1700000001000, contentHash: 'h2',
      inserted: 0, duplicatesPrevented: 4,
      sessions: 1, usageRecords: 0, events: 0,
    });
    const files = db.listIngestionFiles('claude-code');
    assert.equal(files.length, 1);
    // Per-file dedup is overwritten (latest scan), not accumulated
    assert.equal(files[0].duplicates_prevented, 4);
    assert.equal(files[0].content_hash, 'h2');

    const prior = db.priorFileMap('claude-code');
    assert.equal(prior.size, 1);
    assert.equal(prior.get('/tmp/x.jsonl')!.size, 105);
  } finally { teardown(); }
});

test('bumpTotalDuplicates accumulates across calls; dataHealth reads it', () => {
  setup();
  try {
    assert.equal(db.getTotalDuplicates(), 0);
    db.bumpTotalDuplicates(3);
    db.bumpTotalDuplicates(7);
    assert.equal(db.getTotalDuplicates(), 10);
  } finally { teardown(); }
});

test('dataHealth aggregates confidence buckets and dedup totals', () => {
  setup();
  try {
    db.upsertSession(makeSession('s', '2026-07-22T10:00:00Z', 'completed', 100, 50, 0.1));
    const mkU = (id: string, uc: 'exact' | 'estimated' | 'unknown', cc: 'exact' | 'estimated' | 'unknown', unknownModel = false): UsageRecord => ({
      id, sessionId: 'claude-code:s', agentId: 'claude-code', model: 'm',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 2, estimatedCost: 0, timestamp: '2026-07-22T10:00:00Z',
      usageConfidence: uc, costConfidence: cc, unknownModel,
    });
    db.insertUsage(mkU('u1', 'exact', 'exact'));
    db.insertUsage(mkU('u2', 'exact', 'estimated'));
    db.insertUsage(mkU('u3', 'unknown', 'unknown', true));
    db.recordIngestionFile({
      provider: 'claude-code', filePath: '/tmp/x', size: 1, mtimeMs: 1, contentHash: 'h',
      inserted: 3, duplicatesPrevented: 0,
      sessions: 1, usageRecords: 3, events: 0,
    });
    db.bumpTotalDuplicates(5);

    const h = db.dataHealth();
    assert.equal(h.totalSessions, 1);
    assert.equal(h.totalUsageRecords, 3);
    assert.deepEqual(h.usage, { exact: 2, estimated: 0, unknown: 1 });
    assert.deepEqual(h.cost, { exact: 1, estimated: 1, unknown: 1 });
    assert.equal(h.duplicatesPrevented, 5); // from settings, not ingestion_files
    assert.equal(h.ingestionFiles, 1);
    assert.equal(h.ingestionFileSize, 1);
    assert.equal(h.perAgent.length, 0);
    assert.ok(h.lastScanAt === undefined || typeof h.lastScanAt === 'string');
  } finally { teardown(); }
});

test('dataHealth perAgent summary joins ingestion_files correctly', () => {
  setup();
  try {
    db.upsertAgent({ id: 'claude-code', name: 'Claude Code', type: 'claude-code', dataDir: '/x', enabled: true });
    db.setAgentScanned('claude-code', '2026-07-22T12:00:00Z');
    db.recordIngestionFile({
      provider: 'claude-code', filePath: '/tmp/x', size: 100, mtimeMs: 1, contentHash: 'h',
      inserted: 10, duplicatesPrevented: 0,
      sessions: 2, usageRecords: 10, events: 5,
    });
    const h = db.dataHealth();
    const a = h.perAgent.find((x) => x.agentId === 'claude-code');
    assert.ok(a);
    assert.equal(a!.files, 1);
    assert.equal(a!.sessions, 2);
    assert.equal(a!.usage, 10);
    assert.equal(a!.duplicates, 0); // per-file dedup is now 0 (overwrite semantics)
    assert.equal(a!.lastScanAt, '2026-07-22T12:00:00Z');
  } finally { teardown(); }
});

function makeSession(id: string, start: string, status: string, inp: number, out: number, cost: number): AgentSession {
  return {
    id,
    agentId: 'claude-code',
    agentType: 'claude-code',
    externalId: id,
    project: '/p',
    projectDisplay: '/p',
    startTime: start,
    endTime: status === 'running' ? undefined : start,
    status: status as 'running' | 'completed' | 'failed' | 'unknown',
    model: 'm',
    messageCount: 1,
    totalInputTokens: inp,
    totalOutputTokens: out,
    totalTokens: inp + out,
    estimatedCost: cost,
    fileOps: 0,
    toolCalls: 0,
  };
}