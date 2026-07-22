import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const NUMBER_FMT = new Intl.NumberFormat('en-US');
const USD_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return NUMBER_FMT.format(Math.round(n));
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatUSD(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (Math.abs(amount) > 0 && Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return USD_FMT.format(amount);
}

export function formatRelative(iso: string | undefined | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return 'in future';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300';
    case 'completed': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300';
    case 'failed': return 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300';
    default: return 'bg-muted text-muted-foreground';
  }
}

export function agentColor(type: string): string {
  switch (type) {
    case 'claude-code': return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200';
    case 'codex': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
    case 'grok': return 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200';
    case 'gemini': return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200';
    case 'hermes': return 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200';
    default: return 'bg-muted text-muted-foreground';
  }
}