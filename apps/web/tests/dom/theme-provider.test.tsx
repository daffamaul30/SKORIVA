/**
 * T-31.8 — Theme provider configuration and behaviour.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/providers/theme-provider';
import { THEME_NAMES, THEME_PROVIDER_PROPS, THEME_STORAGE_KEY } from '@/lib/theme/theme';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.className = '';
  localStorage.clear();
});

describe('theme configuration', () => {
  it('uses the approved provider props', () => {
    expect(THEME_PROVIDER_PROPS).toStrictEqual({
      attribute: 'class',
      defaultTheme: 'system',
      enableSystem: true,
      storageKey: 'skoriva-theme',
      disableTransitionOnChange: true,
    });
  });

  it('supports light, dark, and system', () => {
    expect([...THEME_NAMES]).toStrictEqual(['light', 'dark', 'system']);
    expect(THEME_STORAGE_KEY).toBe('skoriva-theme');
  });

  it('uses a dedicated storage key, not a generic one', () => {
    expect(THEME_STORAGE_KEY).not.toBe('theme');
  });
});

describe('ThemeProvider', () => {
  it('renders its children', () => {
    render(
      <ThemeProvider>
        <p>Konten</p>
      </ThemeProvider>,
    );

    expect(screen.getByText('Konten')).toBeInTheDocument();
  });

  it('applies the dark class when the resolved theme is dark', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(
      <ThemeProvider>
        <p>Konten</p>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('applies the light class when the resolved theme is light', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    render(
      <ThemeProvider>
        <p>Konten</p>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  it('does not render a theme toggle in this task', () => {
    render(
      <ThemeProvider>
        <p>Konten</p>
      </ThemeProvider>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
