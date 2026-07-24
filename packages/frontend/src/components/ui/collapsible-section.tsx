/**
 * v1.20: CollapsibleSection — pure presentation disclosure widget.
 *
 * A controlled-or-uncontrolled collapsible container with a clickable
 * header (chevron + title) and a content area that mounts/unmounts
 * based on `expanded` state. Used by InvestigationWorkspace to let
 * users fold the four secondary sections (Narrative / Timeline /
 * Evidence / Recommended Actions) without losing their place.
 *
 * Design constraints:
 *   - Pure presentation: no fetch, no storage, no backend call.
 *   - Controlled or uncontrolled:
 *       * if `expanded` prop is provided, parent owns the state and
 *         is notified via `onExpandedChange`.
 *       * if `expanded` is omitted, the section owns its state via
 *         useState, seeded by `defaultExpanded` (default false).
 *   - Keyboard accessible: the header is a real <button>; Enter and
 *     Space toggle expansion.
 *   - Subtle default sizing: small text, muted-foreground chevron,
 *     identical look to existing h5/h6 section headers so the
 *     InvestigationWorkspace reads as one panel.
 */

import * as React from 'react';
import { cn } from '../../lib/format';

export interface CollapsibleSectionProps {
  /** Required. Displayed in the header. */
  title: string;
  /** Required. Content rendered when expanded. */
  children: React.ReactNode;
  /**
   * Optional. When provided, the section is "controlled": parent owns
   * the open state and receives change notifications. When omitted,
   * the section manages its own state, seeded by `defaultExpanded`.
   */
  expanded?: boolean;
  /**
   * Optional. Fired whenever the user toggles the section. Receives
   * the next expanded value (the toggled state, not the previous).
   * Only meaningful in controlled mode.
   */
  onExpandedChange?: (next: boolean) => void;
  /**
   * Optional. Initial expanded state for uncontrolled mode.
   * Defaults to false. Ignored in controlled mode.
   */
  defaultExpanded?: boolean;
  /** Optional. Small status text shown in the header right side
   *  (e.g. "3 items", "loading", "error"). */
  hint?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

export function CollapsibleSection({
  title,
  children,
  expanded: controlledExpanded,
  onExpandedChange,
  defaultExpanded = false,
  hint,
  className,
}: CollapsibleSectionProps) {
  const isControlled = controlledExpanded !== undefined;
  const [internalExpanded, setInternalExpanded] = React.useState(defaultExpanded);
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  const toggle = React.useCallback(() => {
    const next = !expanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  }, [expanded, isControlled, onExpandedChange]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  return (
    <section className={cn('mt-1', className)}>
      <button
        type="button"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center justify-between gap-2',
          'rounded px-1 py-0.5',
          'text-[10px] uppercase tracking-wider text-muted-foreground',
          'hover:bg-muted/40 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block w-3 text-muted-foreground/70">
            {expanded ? '▾' : '▸'}
          </span>
          <span>{title}</span>
        </span>
        {hint && <span className="text-muted-foreground/70 normal-case tracking-normal">{hint}</span>}
      </button>
      {expanded && (
        <div className="mt-1 pl-3" role="region" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  );
}