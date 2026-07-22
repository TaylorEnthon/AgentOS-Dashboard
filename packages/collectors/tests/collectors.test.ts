import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeCollector, CodexCollector, GrokCollector, GeminiCollector, HermesCollector } from '../src/index.js';
import { normalizeTimestamp, decodeClaudeProjectDir } from '../src/base.js';

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
    assert.equal(sess.externalId, 's1');
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