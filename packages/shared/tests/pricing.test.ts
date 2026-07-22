import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, resolvePricing, DEFAULT_PRICING } from '../src/pricing.js';

test('exact-match pricing', () => {
  const c = computeCost('claude-sonnet-4', 1_000_000, 500_000);
  // 3 + 7.5 = 10.5
  assert.equal(c.inputCost, 3);
  assert.equal(c.outputCost, 7.5);
  assert.equal(c.total, 10.5);
});

test('prefix-match pricing', () => {
  const p = resolvePricing('claude-3-5-sonnet-20241022');
  // longest prefix should be claude-3-5-sonnet
  assert.equal(p.inputPerMTok, DEFAULT_PRICING['claude-3-5-sonnet'].inputPerMTok);
});

test('cache pricing defaults', () => {
  const c = computeCost('gpt-4o', 0, 0, 1_000_000, 1_000_000);
  // cacheRead defaults to input*0.1 = 0.25; cacheWrite defaults to input*1.25 = 3.125
  assert.equal(c.cacheCost.toFixed(3), '3.375');
});

test('user override beats defaults', () => {
  const overrides = { 'claude-sonnet-4': { inputPerMTok: 1, outputPerMTok: 2 } };
  const c = computeCost('claude-sonnet-4', 1_000_000, 1_000_000, 0, 0, overrides);
  assert.equal(c.total, 3);
});

test('unknown model gets safe fallback', () => {
  const c = computeCost('mystery-model-9000', 1_000_000, 1_000_000);
  assert.equal(c.total, 2); // fallback 1+1
});