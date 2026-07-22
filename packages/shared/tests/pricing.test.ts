import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCost,
  resolvePricing,
  DEFAULT_PRICING,
  SAFE_FALLBACK_PRICING,
  deriveUsageConfidence,
} from '../src/pricing.js';
import { formatCost } from '../src/format.js';
import { worseConfidence } from '../src/types.js';

test('exact-match pricing', () => {
  const c = computeCost('claude-sonnet-4', 1_000_000, 500_000);
  assert.equal(c.inputCost, 3);
  assert.equal(c.outputCost, 7.5);
  assert.equal(c.total, 10.5);
  assert.equal(c.costConfidence, 'exact');
});

test('prefix-match pricing', () => {
  const res = resolvePricing('claude-3-5-sonnet-20241022');
  assert.equal(res.pricing.inputPerMTok, DEFAULT_PRICING['claude-3-5-sonnet'].inputPerMTok);
  assert.equal(res.confidence, 'estimated');
  assert.equal(res.matchedKey, 'claude-3-5-sonnet');
});

test('cache pricing defaults', () => {
  const c = computeCost('gpt-4o', 0, 0, 1_000_000, 1_000_000);
  // cacheRead defaults to input*0.1 = 0.25; cacheWrite defaults to input*1.25 = 3.125
  assert.equal(c.cacheCost.toFixed(3), '3.375');
});

test('user override beats defaults and is exact', () => {
  const overrides = { 'claude-sonnet-4': { inputPerMTok: 1, outputPerMTok: 2 } };
  const c = computeCost('claude-sonnet-4', 1_000_000, 1_000_000, 0, 0, overrides);
  assert.equal(c.total, 3);
  assert.equal(c.costConfidence, 'exact');
});

test('unknown model gets safe fallback and is marked unknown', () => {
  const res = resolvePricing('mystery-model-9000');
  assert.deepEqual(res.pricing, SAFE_FALLBACK_PRICING);
  assert.equal(res.confidence, 'unknown');
  const c = computeCost('mystery-model-9000', 1_000_000, 1_000_000);
  assert.equal(c.costConfidence, 'unknown');
  assert.equal(c.total, 2); // 1+1 fallback
});

test('empty model is unknown', () => {
  const res = resolvePricing('');
  assert.equal(res.confidence, 'unknown');
  const res2 = resolvePricing(undefined);
  assert.equal(res2.confidence, 'unknown');
});

test('override still wins over exact default with newer key', () => {
  const overrides = { 'gpt-5-experimental': { inputPerMTok: 9, outputPerMTok: 30 } };
  const c = computeCost('gpt-5-experimental', 1_000_000, 1_000_000, 0, 0, overrides);
  assert.equal(c.total, 39);
  assert.equal(c.costConfidence, 'exact');
});

test('deriveUsageConfidence: structured field present + tokens > 0 → exact', () => {
  assert.equal(deriveUsageConfidence(100, 50, true), 'exact');
});

test('deriveUsageConfidence: no structured field → unknown', () => {
  assert.equal(deriveUsageConfidence(0, 0, false), 'unknown');
});

test('deriveUsageConfidence: structured field but all zero → unknown', () => {
  assert.equal(deriveUsageConfidence(0, 0, true), 'unknown');
});

test('worseConfidence picks the lower-trust level', () => {
  assert.equal(worseConfidence('exact', 'exact'), 'exact');
  assert.equal(worseConfidence('exact', 'estimated'), 'estimated');
  assert.equal(worseConfidence('estimated', 'unknown'), 'unknown');
  assert.equal(worseConfidence('unknown', 'estimated'), 'unknown');
});

test('formatCost: exact has no prefix, estimated/unknown/undefined do', () => {
  assert.equal(formatCost(12.34, 'exact'), '$12.34');
  assert.equal(formatCost(12.34, 'estimated'), '≈ $12.34');
  assert.equal(formatCost(12.34, 'unknown'), '≈ $12.34');
  assert.equal(formatCost(12.34, undefined), '≈ $12.34'); // unknown → conservative prefix
});