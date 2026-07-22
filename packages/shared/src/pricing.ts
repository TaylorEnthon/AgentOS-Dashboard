/**
 * Built-in model price table (USD per 1M tokens).
 * Users can override any model via settings.
 *
 * Sources are public list prices as of 2025; intentionally conservative —
 * real billing may differ (especially cached tokens). v0.1 is best-effort.
 */

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
 * Find the best pricing entry for an arbitrary model string.
 * Tries:
 *   1. exact match
 *   2. longest prefix match (e.g. "claude-3-5-sonnet-20241022" -> "claude-3-5-sonnet")
 *   3. fallback 1/1 USD per MTok
 */
export function resolvePricing(
  model: string | undefined,
  overrides: Record<string, ModelPricing> = {},
): ModelPricing {
  if (!model) return { inputPerMTok: 1, outputPerMTok: 1 };
  const lower = model.toLowerCase();

  if (overrides[lower]) return overrides[lower];
  if (DEFAULT_PRICING[lower]) return DEFAULT_PRICING[lower];

  // longest-prefix match
  const candidates = Object.keys({ ...DEFAULT_PRICING, ...overrides })
    .filter((k) => lower.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const key = candidates[0];
    return overrides[key] ?? DEFAULT_PRICING[key];
  }

  return { inputPerMTok: 1, outputPerMTok: 1 };
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  total: number;
}

export function computeCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  overrides: Record<string, ModelPricing> = {},
): CostBreakdown {
  const p = resolvePricing(model, overrides);
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
  };
}