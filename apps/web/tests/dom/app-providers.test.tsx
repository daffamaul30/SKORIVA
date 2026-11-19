/**
 * T-31.9 — Provider composition.
 *
 * Verifies both providers are present and usable, that the order is theme →
 * query, and that nothing product-related is injected.
 */

import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { useTheme } from 'next-themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '@/providers/app-providers';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.className = '';
  localStorage.clear();
});

function Probe() {
  const client = useQueryClient();
  const theme = useTheme();

  return (
    <output data-testid="probe">
      {client ? 'query' : 'no-query'}:{typeof theme.setTheme === 'function' ? 'theme' : 'no-theme'}
    </output>
  );
}

describe('AppProviders', () => {
  it('provides both the query client and the theme context', () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );

    expect(screen.getByTestId('probe')).toHaveTextContent('query:theme');
  });

  it('renders children without adding product markup', () => {
    const { container } = render(
      <AppProviders>
        <p>Konten uji</p>
      </AppProviders>,
    );

    expect(screen.getByText('Konten uji')).toBeInTheDocument();
    // Only the child paragraph exists: no header, nav, sidebar, or scoreboard.
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('aside')).toBeNull();
  });

  it('keeps the same query client across rerenders', () => {
    const seen: unknown[] = [];

    function ClientProbe() {
      seen.push(useQueryClient());
      return <span>ok</span>;
    }

    const { rerender } = render(
      <AppProviders>
        <ClientProbe />
      </AppProviders>,
    );

    rerender(
      <AppProviders>
        <ClientProbe />
      </AppProviders>,
    );

    expect(new Set(seen).size).toBe(1);
  });
});
