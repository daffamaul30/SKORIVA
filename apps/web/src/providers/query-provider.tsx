'use client';

/**
 * TanStack Query provider (T-31.3).
 *
 * Next.js creates the client per browser session, not per render and not as a
 * module singleton — a module singleton would be shared across server requests
 * and leak one user's cache into another's. `useState(() => …)` keeps the first
 * instance for the lifetime of the browser app.
 *
 * AppProviders wiring (`layout.tsx`) is T-31.9; this file only exposes the
 * provider and client factory.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueryClientConfig } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { installOperatorCacheIsolation } from '@/features/match-session/operator-cache-isolation';
import {
  MUTATION_RETRY_LIMIT,
  QUERY_STALE_TIME_MS,
  queryRetryDelay,
  shouldRetryMutation,
  shouldRetryQuery,
} from '@/lib/query/query-defaults';

/** Explicit defaults shared by every query and mutation. */
export function createQueryClientConfig(): QueryClientConfig {
  return {
    defaultOptions: {
      queries: {
        // Server data goes stale quickly; the backend is authoritative.
        staleTime: QUERY_STALE_TIME_MS,
        // Bounded retry for transient failures only (see query-defaults).
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        // Operators watch a live dashboard; refocus refetch is noise and the
        // realtime socket (not the query cache) owns match updates.
        refetchOnWindowFocus: false,
        // Reconnect recovery for REST reads is useful after a network drop.
        refetchOnReconnect: true,
        // No network-mode tricks: same-origin proxy, plain requests.
        networkMode: 'online',
      },
      mutations: {
        retry: MUTATION_RETRY_LIMIT,
        retryDelay: queryRetryDelay,
        networkMode: 'online',
      },
    },
  };
}

export function createQueryClient(): QueryClient {
  return new QueryClient(createQueryClientConfig());
}

export interface QueryProviderProps {
  children: ReactNode;
  /** Test seam: inject a client, e.g. to inspect its configuration. */
  client?: QueryClient;
}

export function QueryProvider({ children, client }: QueryProviderProps) {
  // The initial value is computed once per mounted app and never re-created on
  // re-render, which keeps the cache stable for the whole browser session.
  const [queryClient] = useState(() => client ?? createQueryClient());

  // Operator-only cache isolation is installed here, not by product UI (R3).
  useEffect(() => installOperatorCacheIsolation(queryClient), [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Re-exported so consumers do not depend on the library path directly. */
export { shouldRetryMutation };
