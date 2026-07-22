/**
 * Display formatting helpers — used by frontend + backend (for API shaping).
 */

export function formatNumber(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatTokens(n: number): string {
  return `${formatNumber(n)} tok`;
}

export function formatUSD(amount: number): string {
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Format a cost value with a confidence-aware prefix. Use `≈` when the
 * cost is not `exact` so users don't mistake an estimate for a bill.
 * When confidence is `undefined` (legacy data), be conservative and show `≈`.
 */
export function formatCost(
  amount: number,
  confidence: 'exact' | 'estimated' | 'unknown' | undefined,
): string {
  const prefix = confidence === 'exact' ? '' : '≈ ';
  return `${prefix}${formatUSD(amount)}`;
}

export function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) {
    const future = -diff;
    if (future < 60_000) return 'in moments';
    if (future < 3_600_000) return `in ${Math.round(future / 60_000)}m`;
    if (future < 86_400_000) return `in ${Math.round(future / 3_600_000)}h`;
    return `in ${Math.round(future / 86_400_000)}d`;
  }
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function isoDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}