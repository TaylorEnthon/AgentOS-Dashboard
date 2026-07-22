/**
 * Built-in model price table (USD per 1M tokens).
 * Users can override any model via settings.
 *
 * v0.2: every cost now carries a {@link ConfidenceLevel}.
 *   - `exact`:    resolved via override OR DEFAULT_PRICING exact match
 *   - `estimated`: resolved via longest-prefix match (acceptable heuristic)
 *   - `unknown`:  no entry matched → cost is computed against the safe $1/$1
 *                 fallback and the caller is told it's not real.
 */

import type { ConfidenceLevel } from './types.js';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-7-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-haiku-4': { inputPerMTok: 1, outputPerMTok: 5 },

  // OpenAI / Codex
  'gpt-5': { inputPerMTok: 5, outputPerMTok: 20 },
  'gpt-5-mini': { inputPerMTok: 1, outputPerMTok: 4 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4.1': { inputPerMTok: 3, outputPerMTok: 12 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'o3': { inputPerMTok: 10, outputPerMTok: 40 },
  'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'codex-mini': { inputPerMTok: 1, outputPerMTok: 4 },

  // xAI Grok
  'grok-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'grok-3': { inputPerMTok: 3, outputPerMTok: 15 },
  'grok-3-mini': { inputPerMTok: 0.3, outputPerMTok: 0.5 },
  'grok-2': { inputPerMTok: 2, outputPerMTok: 10 },

  // Google Gemini
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },

  // Hermes (hypothetical; user-supplied)
  'hermes-default': { inputPerMTok: 1, outputPerMTok: 3 },
};

/**
 * Result of cost resolution. `confidence` tells the caller whether the
 * number is real or just a safe-but-uninformative fallback.
 */
export interface PricingResolution {
  pricing: ModelPricing;
  confidence: ConfidenceLevel;
  /** The key that actually matched (override > exact > prefix > fallback). */
  matchedKey: string;
}

export const SAFE_FALLBACK_PRICING: ModelPricing = { inputPerMTok: 1, outputPerMTok: 1 };

/**
 * Find the best pricing entry for an arbitrary model string.
 * Resolution order (each step lowers confidence):
 *   1. exact override     → exact
 *   2. exact DEFAULT      → exact
 *   3. longest prefix     → estimated
 *   4. nothing matched    → unknown (uses SAFE_FALLBACK_PRICING)
 */
export function resolvePricing(
  model: string | undefined,
  overrides: Record<string, ModelPricing> = {},
): PricingResolution {
  if (!model) {
    return { pricing: SAFE_FALLBACK_PRICING, confidence: 'unknown', matchedKey: '' };
  }
  const lower = model.toLowerCase();

  if (overrides[lower]) return { pricing: overrides[lower], confidence: 'exact', matchedKey: lower };
  if (DEFAULT_PRICING[lower]) return { pricing: DEFAULT_PRICING[lower], confidence: 'exact', matchedKey: lower };

  // longest-prefix match
  const allKeys = Object.keys({ ...DEFAULT_PRICING, ...overrides });
  const candidates = allKeys
    .filter((k) => lower.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const key = candidates[0];
    return {
      pricing: overrides[key] ?? DEFAULT_PRICING[key],
      confidence: 'estimated',
      matchedKey: key,
    };
  }

  return { pricing: SAFE_FALLBACK_PRICING, confidence: 'unknown', matchedKey: '' };
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  total: number;
  costConfidence: ConfidenceLevel;
}

/**
 * Compute cost and stamp confidence. Callers (collectors) should attach
 * `costConfidence` and `unknownModel` to the resulting UsageRecord.
 */
export function computeCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  overrides: Record<string, ModelPricing> = {},
): CostBreakdown {
  const res = resolvePricing(model, overrides);
  const p = res.pricing;
  const inputCost = (inputTokens / 1_000_000) * p.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * p.outputPerMTok;
  const cacheReadRate = p.cacheReadPerMTok ?? p.inputPerMTok * 0.1;
  const cacheWriteRate = p.cacheWritePerMTok ?? p.inputPerMTok * 1.25;
  const cacheCost =
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate;
  return {
    inputCost,
    outputCost,
    cacheCost,
    total: inputCost + outputCost + cacheCost,
    costConfidence: res.confidence,
  };
}

/**
 * Cheap token-confidence heuristic. `exact` if every present token counter
 * was parsed out of a structured field; `unknown` if the agent gave us
 * nothing; `estimated` if we had to fall back to a derived rule.
 */
export function deriveUsageConfidence(
  inputTokens: number,
  outputTokens: number,
  hadStructuredUsageField: boolean,
): ConfidenceLevel {
  if (!hadStructuredUsageField) return 'unknown';
  if (inputTokens === 0 && outputTokens === 0) return 'unknown';
  return 'exact';
}