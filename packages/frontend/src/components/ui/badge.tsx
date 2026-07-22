import * as React from 'react';
import { cn } from '../../lib/format';

type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({
  tone = 'default',
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  const toneClass: Record<Tone, string> = {
    default: 'bg-secondary text-secondary-foreground',
    muted: 'bg-muted text-muted-foreground',
    success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    danger: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    info: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        toneClass[tone],
        className,
      )}
      {...rest}
    />
  );
}