'use client';

/**
 * Theme provider (T-31.8).
 *
 * Wraps `next-themes` with the approved configuration. `attribute="class"`
 * matches the `@custom-variant dark (&:is(.dark *))` rule in `globals.css`.
 *
 * No toggle UI is created in T-31; that belongs to a later product task.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { THEME_PROVIDER_PROPS } from '@/lib/theme/theme';

export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  return <NextThemesProvider {...THEME_PROVIDER_PROPS}>{children}</NextThemesProvider>;
}
