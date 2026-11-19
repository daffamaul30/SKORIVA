'use client';

/**
 * Application providers (T-31.9).
 *
 * Composition order is fixed by the approved plan:
 * 1. `ThemeProvider` — theme class must be available before anything renders;
 * 2. `QueryProvider` — server-state cache for the whole browser session.
 *
 * Nothing else belongs here: no navigation, no UI, no product components.
 */

import type { ReactNode } from 'react';
import { QueryProvider } from './query-provider';
import { ThemeProvider } from './theme-provider';

export interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ThemeProvider>
      <QueryProvider>{children}</QueryProvider>
    </ThemeProvider>
  );
}
