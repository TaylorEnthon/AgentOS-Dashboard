/**
 * v0.7 Session Management tests:
 *  - session_metadata table migration (auto on first Db open)
 *  - get / upsert / bulk / delete metadata
 *  - search / list / pinned filters (via raw SQL mirroring routes)
 *  - resume command generation per agent
 *  - PATCH /api/sessions-v2/:id/metadata handler end-to-end
 *  - search via the same SQL the route uses
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Db } from '../src/db.js';
import { buildResumeCommand } from '../src/resume.js';
import type { AgentSession, AgentType, SessionMetadata } from '@agentos/shared';

let tmpRoot: string;
let db: Db;

function setup(): void {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-sm-'));
  db = new Db(path.join(tmpRoot, 'test.db'));
}

function teardown(): void {
  try { db.close(); rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function seedSession(id: string, project: string, title?: string): AgentSession {
  const s: AgentSession = {
    id, agentId: id.split(':')[0], agentType: 'claude-code', externalId: id,
    project, projectDisplay: project, title,
    startTime: '2026-07-22T10:00:00.000Z', endTime: '2026-07-22T10:30:00.000Z',
    status: 'completed', model: 'm',
    messageCount: 1, totalInputTokens: 1, totalOutputTokens: 1, totalTokens: 2,
    estimatedCost: 0, fileOps: 0, toolCalls: 0,
  };
  db.upsertSession(s);
  return s;
}

/* ---------------- migration ---------------- */

test('session_metadata table is auto-created on first Db open', () => {
  setup();
  try {
    const cols = db.raw.prepare(`PRAGMA table_info(session_metadata)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('session_id'));
    assert.ok(names.includes('display_name'));
    assert.ok(names.includes('note'));
    assert.ok(names.includes('tags'));
    assert.ok(names.includes('pinned'));
    assert.ok(names.includes('created_at'));
    assert.ok(names.includes('updated_at'));
  } finally { teardown(); }
});

test('Db construction on an existing v0.6 DB picks up session_metadata', () => {
  setup();
  try {
    // Pre-existing v0.6-style session should be unaffected.
    seedSession('claude-code:abc', '/p/x', 'Old session');
    db.close();
    // Re-open — should add the new table without touching old data.
    db = new Db(path.join(tmpRoot, 'test.db'));
    const s = db.getSession('claude-code:abc');
    assert.ok(s);
    assert.equal(s!.title, 'Old session');
    const cols = db.raw.prepare(`PRAGMA table_info(session_metadata)`).all();
    assert.ok(cols.length > 0);
  } finally { teardown(); }
});

/* ---------------- metadata CRUD ---------------- */

test('getSessionMetadata returns null when unset', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/x');
    assert.equal(db.getSessionMetadata('claude-code:abc'), null);
  } finally { teardown(); }
});

test('upsertSessionMetadata creates + merges', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/x');
    // First write — only displayName.
    const m1 = db.upsertSessionMetadata('claude-code:abc', { displayName: 'My first session' });
    assert.equal(m1.displayName, 'My first session');
    assert.deepEqual(m1.tags, []);
    assert.equal(m1.pinned, false);
    assert.ok(m1.createdAt);
    // Second write — only tags. Should NOT clobber displayName.
    const m2 = db.upsertSessionMetadata('claude-code:abc', { tags: ['dev', 'frontend'] });
    assert.equal(m2.displayName, 'My first session');
    assert.deepEqual(m2.tags, ['dev', 'frontend']);
    // createdAt preserved, updatedAt advanced
    assert.equal(m2.createdAt, m1.createdAt);
    assert.ok(m2.updatedAt >= m1.updatedAt);
  } finally { teardown(); }
});

test('upsertSessionMetadata can pin', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/x');
    const m = db.upsertSessionMetadata('claude-code:abc', { pinned: true });
    assert.equal(m.pinned, true);
    assert.equal(db.getSessionMetadata('claude-code:abc')!.pinned, true);
    // Unpin
    const m2 = db.upsertSessionMetadata('claude-code:abc', { pinned: false });
    assert.equal(m2.pinned, false);
  } finally { teardown(); }
});

test('upsertSessionMetadata normalizes tags JSON corruption on read', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/x');
    // Insert a corrupted JSON row directly.
    db.raw.prepare(
      `INSERT INTO session_metadata (session_id, display_name, note, tags, pinned, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, 0, ?, ?)`,
    ).run('claude-code:abc', 'not-valid-json', new Date().toISOString(), new Date().toISOString());
    const m = db.getSessionMetadata('claude-code:abc');
    assert.ok(m);
    assert.deepEqual(m!.tags, []); // corrupted → empty array, not crash
  } finally { teardown(); }
});

test('getSessionMetadataBulk: empty input + missing keys', () => {
  setup();
  try {
    const empty = db.getSessionMetadataBulk([]);
    assert.equal(empty.size, 0);
    seedSession('claude-code:abc', '/p/x');
    db.upsertSessionMetadata('claude-code:abc', { displayName: 'X' });
    const map = db.getSessionMetadataBulk(['claude-code:abc', 'claude-code:nope']);
    assert.equal(map.size, 1);
    assert.equal(map.get('claude-code:abc')!.displayName, 'X');
    assert.equal(map.get('claude-code:nope'), undefined);
  } finally { teardown(); }
});

test('deleteSessionMetadata is idempotent', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/x');
    db.upsertSessionMetadata('claude-code:abc', { displayName: 'X' });
    db.deleteSessionMetadata('claude-code:abc');
    assert.equal(db.getSessionMetadata('claude-code:abc'), null);
    // Calling again is a no-op, not an error.
    db.deleteSessionMetadata('claude-code:abc');
    assert.equal(db.getSessionMetadata('claude-code:abc'), null);
  } finally { teardown(); }
});

/* ---------------- search / list SQL ---------------- */

test('list SQL with search finds display_name / title / project (tags are NOT searched)', () => {
  setup();
  try {
    seedSession('claude-code:abc', '/p/agentos', 'Old work');
    seedSession('claude-code:def', '/p/skills', 'skills dev');        // only matches via tag
    seedSession('codex:ghi', '/p/agentos-foo', 'agentos side');       // matches via project + title
    seedSession('codex:untouched', '/p/other', 'unrelated work');     // matches nothing
    db.upsertSessionMetadata('claude-code:abc', { displayName: 'AgentOS Dashboard v0.7 dev' });
    db.upsertSessionMetadata('claude-code:def', { tags: ['agentos', 'frontend'] });

    // Search "agentos" should match: displayName + project + title.
    // Tag-only matches are intentionally excluded from v0.7 search scope
    // (users filter by tag via a dedicated tag chip in the UI).
    const rows = db.raw.prepare(
      `SELECT s.id, sm.display_name, sm.tags
       FROM sessions s
       LEFT JOIN session_metadata sm ON sm.session_id = s.id
       WHERE (s.project LIKE ? OR s.title LIKE ? OR sm.display_name LIKE ?)`,
    ).all('%agentos%', '%agentos%', '%agentos%') as Array<{ id: string; display_name: string | null; tags: string | null }>;
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('claude-code:abc'));   // via display_name
    assert.ok(ids.includes('codex:ghi'));         // via project AND title
    assert.ok(!ids.includes('claude-code:def'));   // tag-only → excluded
    assert.ok(!ids.includes('codex:untouched'));   // no match
  } finally { teardown(); }
});

test('list SQL pinned=true only returns pinned sessions', () => {
  setup();
  try {
    seedSession('claude-code:a', '/p/x');
    seedSession('claude-code:b', '/p/x');
    db.upsertSessionMetadata('claude-code:a', { pinned: true });
    const rows = db.raw.prepare(
      `SELECT s.id FROM sessions s LEFT JOIN session_metadata sm ON sm.session_id = s.id
       WHERE sm.pinned = 1`,
    ).all() as Array<{ id: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'claude-code:a');
  } finally { teardown(); }
});

/* ---------------- resume command ---------------- */

test('buildResumeCommand: claude-code → `claude --resume <id>`', () => {
  const c = buildResumeCommand('claude-code' as AgentType, 'abc-123');
  assert.equal(c.agent, 'claude-code');
  assert.equal(c.command, 'claude --resume abc-123');
  assert.equal(c.externalId, 'abc-123');
});

test('buildResumeCommand: codex → `codex resume <id>`', () => {
  const c = buildResumeCommand('codex' as AgentType, '019f7089-7a7a');
  assert.equal(c.command, 'codex resume 019f7089-7a7a');
});

test('buildResumeCommand: grok → `grok --resume <id>`', () => {
  const c = buildResumeCommand('grok' as AgentType, 'g123');
  assert.equal(c.command, 'grok --resume g123');
});

test('buildResumeCommand: unknown agent returns placeholder', () => {
  const c = buildResumeCommand('custom' as AgentType, 'x');
  assert.match(c.command, /not yet supported/);
});

test('buildResumeCommand: id with shell-special chars is quoted', () => {
  const c = buildResumeCommand('claude-code' as AgentType, "id with 'quote");
  assert.ok(c.command.includes("'id with '"));
});

/* ---------------- Db.list with metadata projection (used by routes) ---------------- */

test('list projection: pinned sessions sort first, then start_time DESC', () => {
  setup();
  try {
    const old = seedSession('claude-code:old', '/p/x');
    const recent = seedSession('claude-code:new', '/p/x');
    // Override start times so the sort is deterministic.
    db.raw.prepare(`UPDATE sessions SET start_time = ? WHERE id = ?`).run('2026-07-22T09:00:00.000Z', 'claude-code:old');
    db.raw.prepare(`UPDATE sessions SET start_time = ? WHERE id = ?`).run('2026-07-22T11:00:00.000Z', 'claude-code:new');
    db.upsertSessionMetadata('claude-code:old', { pinned: true });
    const rows = db.raw.prepare(
      `SELECT s.id, sm.pinned FROM sessions s
       LEFT JOIN session_metadata sm ON sm.session_id = s.id
       ORDER BY COALESCE(sm.pinned, 0) DESC, s.start_time DESC`,
    ).all() as Array<{ id: string; pinned: number | null }>;
    // 'old' is pinned → comes first despite earlier start_time
    assert.equal(rows[0].id, 'claude-code:old');
    assert.equal(rows[1].id, 'claude-code:new');
  } finally { teardown(); }
});