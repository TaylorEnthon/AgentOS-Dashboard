/**
 * v1.20: CollapsibleSection component tests.
 *
 * Covers the four spec-required behaviours plus a few extras that
 * protect future refactors:
 *
 *   - uncontrolled mode (defaultExpanded) — internal state wins
 *   - controlled mode (expanded + onExpandedChange) — parent owns state
 *   - keyboard accessibility — Enter / Space toggle
 *   - hint rendering — visible in header when provided
 *
 * No fetch, no backend, no storage — these are pure DOM assertions.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { CollapsibleSection } from '../components/ui/collapsible-section';

describe('CollapsibleSection', () => {
  it('starts collapsed by default and renders its title in the header', () => {
    render(
      <CollapsibleSection title="Narrative">
        <p>hidden body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByRole('button', { name: /Narrative/i })).toBeInTheDocument();
    // Body is not rendered when collapsed
    expect(screen.queryByText('hidden body')).not.toBeInTheDocument();
    // Chevron points right when collapsed
    expect(screen.getByRole('button', { name: /Narrative/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('respects defaultExpanded=true (uncontrolled mode)', () => {
    render(
      <CollapsibleSection title="Evidence" defaultExpanded>
        <p>visible body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('visible body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Evidence/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles on click in uncontrolled mode', () => {
    render(
      <CollapsibleSection title="Timeline">
        <p>body</p>
      </CollapsibleSection>,
    );
    const button = screen.getByRole('button', { name: /Timeline/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles on Enter and Space keys (keyboard accessibility)', () => {
    render(
      <CollapsibleSection title="Actions">
        <p>body</p>
      </CollapsibleSection>,
    );
    const button = screen.getByRole('button', { name: /Actions/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(button, { key: 'Enter' });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(button, { key: ' ' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses controlled state when expanded + onExpandedChange are provided', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <CollapsibleSection title="Controlled" expanded={open} onExpandedChange={setOpen}>
          <p>body</p>
        </CollapsibleSection>
      );
    }
    render(<Harness />);
    const button = screen.getByRole('button', { name: /Controlled/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('calls onExpandedChange with the toggled value (not the previous)', () => {
    // Controlled mode: parent owns the state via setOpen, so each click
    // sees the previous toggle reflected in the next `expanded` value.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <CollapsibleSection title="X" expanded={open} onExpandedChange={setOpen}>
          <p>body</p>
        </CollapsibleSection>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /X/i }));
    expect(screen.getByRole('button', { name: /X/i })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: /X/i }));
    expect(screen.getByRole('button', { name: /X/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the hint string in the header', () => {
    render(
      <CollapsibleSection title="Evidence" hint="3 items">
        <p>body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('3 items')).toBeInTheDocument();
  });
});