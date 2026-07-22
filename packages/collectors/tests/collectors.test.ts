import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeCollector, CodexCollector, GrokCollector, GeminiCollector, HermesCollector } from '../src/index.js';
import { normalizeTimestamp, decodeClaudeProjectDir, hashFile, isFileUnchanged } from '../src/base.js';

let tmpRoot: string;

function setupTmp(): string {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentos-test-'));
  return tmpRoot;
}

function teardownTmp(): void {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('Claude collector parses a single JSONL session', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 'session-1.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'custom-title', sessionId: 's1', timestamp: '2026-07-22T10:00:00.000Z', customTitle: 'Hello session' }),
      JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-07-22T10:00:01.000Z', content: 'hi' }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-07-22T10:00:02.000Z',
        message: {
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hello back' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-07-22T10:00:03.000Z',
        message: {
          model: 'claude-sonnet-4',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'foo.ts' } }],
          usage: { input_tokens: 200, output_tokens: 30 },
        },
      }),
    ].join('\n'));

    const collector = new ClaudeCollector();
    const agent = { id: 'claude-code', type: 'claude-code' as const, dataDir: root };
    const result = await collector.scan(agent);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.usage.length, 2);
    const sess = result.sessions[0];
    // External id is derived from the filename (the session uuid), which is
    // more robust than trusting per-record `sessionId` (some Claude lines
    // omit it). See parseSessionFile().
    assert.equal(sess.externalId, 'session-1');
    assert.equal(sess.messageCount, 3);
    assert.equal(sess.totalInputTokens, 300);
    assert.equal(sess.totalOutputTokens, 80);
    assert.equal(sess.model, 'claude-sonnet-4');
    assert.equal(sess.toolCalls, 1);
    assert.ok(sess.estimatedCost > 0);
    assert.equal(result.events.some((e) => e.type === 'message'), true);
    assert.equal(result.events.some((e) => e.type === 'tool-call' && e.detail === 'Read'), true);
  } finally { teardownTmp(); }
});

test('Codex collector parses rollout JSONL', async () => {
  const root = setupTmp();
  try {
    const archived = path.join(root, 'archived_sessions');
    mkdirSync(archived, { recursive: true });
    const file = path.join(archived, 'rollout-2026-07-22T10-00-00-019f2aba-55e9-78c0-bd6b-63ee5aa5e386.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-22T10:00:00.000Z', payload: { id: '019f2aba-55e9-78c0-bd6b-63ee5aa5e386', model: 'gpt-5' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T10:00:02.000Z',
        payload: {
          model: 'gpt-5',
          items: [{ type: 'message', role: 'user', content: 'hi' }],
          response: { usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-22T10:00:03.000Z',
        payload: {
          model: 'gpt-5',
          items: [{ type: 'function_call', function_call: { name: 'exec_command', arguments: '{}' } }],
        },
      }),
    ].join('\n'));

    const collector = new CodexCollector();
    const agent = { id: 'codex', type: 'codex' as const, dataDir: root };
    const result = await collector.scan(agent);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.usage.length, 1);
    assert.equal(result.sessions[0].totalInputTokens, 500);
    assert.equal(result.sessions[0].toolCalls, 1);
  } finally { teardownTmp(); }
});

test('Grok collector parses prompt_history.jsonl', async () => {
  const root = setupTmp();
  try {
    const projectDir = path.join(root, 'sessions', 'D%3A%5Cproject%5Cfoo');
    const sessionDir = path.join(projectDir, 'sess-uuid-1');
    mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'prompt_history.jsonl');
    writeFileSync(file, [
      JSON.stringify({ timestamp: '2026-07-22T10:00:00.000Z', role: 'user', content: 'hi' }),
      JSON.stringify({
        timestamp: '2026-07-22T10:00:01.000Z',
        role: 'assistant',
        model: 'grok-4',
        content: 'hi back',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      JSON.stringify({
        timestamp: '2026-07-22T10:00:02.000Z',
        role: 'tool',
        tool_call: { name: 'web_search' },
      }),
    ].join('\n'));

    const collector = new GrokCollector();
    const agent = { id: 'grok', type: 'grok' as const, dataDir: root };
    const result = await collector.scan(agent);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].projectDisplay.includes('foo'), true);
    assert.equal(result.sessions[0].totalInputTokens, 10);
    assert.equal(result.usage.length, 1);
  } finally { teardownTmp(); }
});

test('Gemini stub returns no data but detects dir', async () => {
  const root = setupTmp();
  try {
    mkdirSync(path.join(root, 'history'), { recursive: true });
    const collector = new GeminiCollector();
    const dataDir = await collector.resolveDataDir(root);
    assert.equal(dataDir, root);
    const result = await collector.scan({ id: 'gemini', type: 'gemini', dataDir: root });
    assert.equal(result.sessions.length, 0);
  } finally { teardownTmp(); }
});

test('Hermes stub returns null when dir missing', async () => {
  const prev = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  try {
    // Inject a fake home so ~/.hermes is guaranteed missing.
    const collector = new HermesCollector('Z:\\definitely-not-there');
    const dataDir = await collector.resolveDataDir();
    assert.equal(dataDir, null);
  } finally {
    if (prev !== undefined) process.env.HERMES_HOME = prev;
  }
});

test('Claude collector ignores malformed lines gracefully', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-x');
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 's.jsonl');
    writeFileSync(file, [
      'this is not json',
      JSON.stringify({ type: 'user', sessionId: 'a', timestamp: '2026-07-22T10:00:00.000Z' }),
      '',
    ].join('\n'));
    const collector = new ClaudeCollector();
    const result = await collector.scan({ id: 'claude-code', type: 'claude-code', dataDir: root });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].messageCount, 1);
  } finally { teardownTmp(); }
});

test('normalizeTimestamp handles ISO, epoch seconds, and epoch ms', () => {
  const iso = normalizeTimestamp('2026-07-22T10:00:00.000Z');
  assert.equal(typeof iso, 'string');
  assert.ok(iso!.startsWith('2026-07-22'));
  const sec = normalizeTimestamp(1784699979);
  assert.equal(typeof sec, 'string');
  assert.ok(sec!.startsWith('2026-07-22'));
  const ms = normalizeTimestamp(1784699979000);
  assert.equal(ms, sec);
  assert.equal(normalizeTimestamp(null), undefined);
  assert.equal(normalizeTimestamp('garbage'), undefined);
});

test('decodeClaudeProjectDir collapses double dashes', () => {
  assert.equal(decodeClaudeProjectDir('D--project-ai-dev-loop'), 'D:/project/ai/dev/loop');
  assert.equal(decodeClaudeProjectDir('D--project-MY-AgentOS-Dashboard'), 'D:/project/MY/AgentOS/Dashboard');
});

/* -------------------- v0.2 provenance / confidence / incremental -------------------- */

test('Claude scan attaches SourceMeta + stamps confidence', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 's.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z', content: 'hi' }),
      JSON.stringify({
        type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:01.000Z',
        message: {
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi back' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ].join('\n'));

    const result = await new ClaudeCollector().scan({ id: 'claude-code', type: 'claude-code', dataDir: root });

    // collectedAt present + files[] populated with the source file
    assert.ok(result.collectedAt);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].sourceFile, file);
    assert.ok(result.files[0].size > 0);
    assert.ok(result.files[0].contentHash.length === 64); // sha256 hex

    // SourceMeta on every persisted record
    const sess = result.sessions[0];
    assert.ok(sess.source);
    assert.equal(sess.source!.sourceProvider, 'claude-code');
    assert.equal(sess.source!.sourceFile, file);
    assert.equal(sess.source!.sourceId, sess.id);
    assert.equal(sess.source!.collectedAt, result.collectedAt);

    const u = result.usage[0];
    assert.ok(u.source);
    assert.equal(u.source!.sourceFile, file);
    assert.equal(u.source!.sourceId, u.id);

    // Confidence: claude-sonnet-4 is exact-match
    assert.equal(u.usageConfidence, 'exact');
    assert.equal(u.costConfidence, 'exact');
    assert.equal(u.unknownModel, false);
    assert.equal(sess.costConfidence, 'exact');
    assert.equal(sess.usageConfidence, 'exact');
  } finally { teardownTmp(); }
});

test('Unknown model stamps costConfidence=unknown + unknownModel=true', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z',
      message: { model: 'mystery-future-9001', content: [], usage: { input_tokens: 1000, output_tokens: 200 } },
    }));

    const result = await new ClaudeCollector().scan({ id: 'claude-code', type: 'claude-code', dataDir: root });
    const u = result.usage[0];
    assert.equal(u.costConfidence, 'unknown');
    assert.equal(u.unknownModel, true);
    // Token counts still exact (came from structured field), even though cost is unknown
    assert.equal(u.usageConfidence, 'exact');
    assert.equal(result.sessions[0].costConfidence, 'unknown');
  } finally { teardownTmp(); }
});

test('Assistant message without usage field → tokens unknown', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z',
      message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: 'no usage' }] },
    }));
    const result = await new ClaudeCollector().scan({ id: 'claude-code', type: 'claude-code', dataDir: root });
    assert.equal(result.usage.length, 0);
    assert.equal(result.sessions[0].usageConfidence, 'unknown');
  } finally { teardownTmp(); }
});

test('Prefix-match model → costConfidence=estimated', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z',
      message: { model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
    }));
    const result = await new ClaudeCollector().scan({ id: 'claude-code', type: 'claude-code', dataDir: root });
    const u = result.usage[0];
    assert.equal(u.costConfidence, 'estimated');
    assert.equal(u.unknownModel, false);
    // prefix match still produces a real number, not the 1/1 fallback
    assert.ok(u.estimatedCost > 0);
  } finally { teardownTmp(); }
});

test('Incremental mode skips files whose fingerprint is unchanged', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 's.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z',
      message: { model: 'claude-sonnet-4', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
    }));

    const collector = new ClaudeCollector();
    const agent = { id: 'claude-code', type: 'claude-code', dataDir: root };

    // First scan in full mode → produces a fingerprint
    const first = await collector.scan(agent, { mode: 'full' });
    assert.equal(first.files.length, 1);
    const fp = first.files[0];

    // Second scan in incremental mode with prior state → should skip
    const priorFiles = new Map([[file, { size: fp.size, mtimeMs: fp.mtimeMs, contentHash: fp.contentHash }]]);
    const second = await collector.scan(agent, { mode: 'incremental', priorFiles });
    assert.equal(second.sessions.length, 0);
    assert.equal(second.usage.length, 0);
    assert.equal(second.files.length, 0); // nothing read

    // Third scan: file content changed → must re-read
    writeFileSync(file, JSON.stringify({
      type: 'assistant', sessionId: 's2', timestamp: '2026-07-22T11:00:00.000Z',
      message: { model: 'claude-sonnet-4', content: [], usage: { input_tokens: 999, output_tokens: 0 } },
    }));
    const third = await collector.scan(agent, { mode: 'incremental', priorFiles });
    assert.equal(third.sessions.length, 1);
    assert.equal(third.sessions[0].totalInputTokens, 999);
  } finally { teardownTmp(); }
});

test('Scan is idempotent: running twice yields identical session ids', async () => {
  const root = setupTmp();
  try {
    const proj = path.join(root, 'projects', 'D--project-foo');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 's.jsonl'), [
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-07-22T10:00:00.000Z' }),
      JSON.stringify({
        type: 'assistant', sessionId: 's', timestamp: '2026-07-22T10:00:01.000Z',
        message: { model: 'claude-sonnet-4', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
      }),
    ].join('\n'));

    const collector = new ClaudeCollector();
    const agent = { id: 'claude-code', type: 'claude-code', dataDir: root };
    const a = await collector.scan(agent);
    const b = await collector.scan(agent);
    assert.equal(a.sessions[0].id, b.sessions[0].id);
    assert.equal(a.usage[0].id, b.usage[0].id);
  } finally { teardownTmp(); }
});

test('hashFile + isFileUnchanged detect modifications', async () => {
  const root = setupTmp();
  try {
    const file = path.join(root, 'x.txt');
    writeFileSync(file, 'hello');
    const fp1 = await hashFile(file);
    assert.ok(fp1.contentHash.length === 64);

    // unchanged
    assert.equal(isFileUnchanged(fp1, fp1), true);

    // modify content → hash will change
    writeFileSync(file, 'hello world');
    const fp2 = await hashFile(file);
    assert.notEqual(fp1.contentHash, fp2.contentHash);
    assert.equal(isFileUnchanged(fp2, fp1), false);

    // no prior → always "changed"
    assert.equal(isFileUnchanged(fp1, undefined), false);
  } finally { teardownTmp(); }
});