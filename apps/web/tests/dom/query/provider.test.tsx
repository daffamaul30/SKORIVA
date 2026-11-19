/**
 * T-31.3 — QueryClient configuration, provider stability, and query-key shape.
 *
 * Runs in jsdom like the FE-G4 DOM tests, and drives a real QueryClient so the
 * assertions describe behaviour rather than a config object copy.
 */

import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/api-error';
import {
  MUTATION_RETRY_LIMIT,
  QUERY_RETRY_LIMIT,
  QUERY_STALE_TIME_MS,
  shouldRetryMutation,
  shouldRetryQuery,
} from '@/lib/query/query-defaults';
import { queryKeys } from '@/lib/query/query-keys';
import {
  QueryProvider,
  createQueryClient,
  createQueryClientConfig,
} from '@/providers/query-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

describe('QueryClient configuration', () => {
  it('sets explicit query defaults', () => {
    const config = createQueryClientConfig();
    const queries = config.defaultOptions?.queries;

    expect(queries?.staleTime).toBe(QUERY_STALE_TIME_MS);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(true);
    expect(queries?.retry).toBe(shouldRetryQuery);
  });

  it('bounds mutation retries instead of retrying forever', () => {
    const config = createQueryClientConfig();
    const mutations = config.defaultOptions?.mutations;

    expect(mutations?.retry).toBe(MUTATION_RETRY_LIMIT);
    expect(MUTATION_RETRY_LIMIT).toBe(0);
    expect(shouldRetryMutation()).toBe(false);
  });

  it('creates independent clients (no module-level singleton)', () => {
    const first = createQueryClient();
    const second = createQueryClient();

    expect(first).toBeInstanceOf(QueryClient);
    expect(first).not.toBe(second);
    expect(first.getQueryCache()).not.toBe(second.getQueryCache());
  });

  it('keeps the same client across provider rerenders', () => {
    const seen: QueryClient[] = [];

    function ClientProbe() {
      seen.push(useQueryClient());
      return <output data-testid="probe">ok</output>;
    }

    const { rerender } = render(
      <QueryProvider>
        <ClientProbe />
      </QueryProvider>,
    );

    rerender(
      <QueryProvider>
        <ClientProbe />
      </QueryProvider>,
    );
    rerender(
      <QueryProvider>
        <ClientProbe />
      </QueryProvider>,
    );

    expect(screen.getByTestId('probe')).toBeInTheDocument();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
  });
});

describe('provider runs queries and mutations', () => {
  function Harness() {
    const query = useQuery({
      queryKey: queryKeys.events.list(),
      queryFn: async () => ({ events: ['A'] }),
    });

    const mutation = useMutation({
      mutationFn: async (value: string) => `saved:${value}`,
      retry: false,
    });

    return (
      <div>
        <output data-testid="events">{query.data?.events.join(',') ?? 'loading'}</output>
        <button type="button" onClick={() => mutation.mutate('A')}>
          Simpan
        </button>
        <output data-testid="mutation">{mutation.data ?? 'idle'}</output>
      </div>
    );
  }

  it('fetches a query and completes a mutation through the provider', async () => {
    render(
      <QueryProvider>
        <Harness />
      </QueryProvider>,
    );

    expect(await screen.findByText('A')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Simpan' }).click();

    expect(await screen.findByText('saved:A')).toBeInTheDocument();
  });

  it('exposes the default retry policy to the cache', async () => {
    const client = createQueryClient();
    const failing = vi.fn().mockRejectedValue(
      new ApiClientError({ status: 500, code: 'INTERNAL_ERROR' }),
    );

    function Failing() {
      const query = useQuery({ queryKey: ['probe', 'retry'], queryFn: failing });
      return <output data-testid="state">{query.status}</output>;
    }

    render(
      <QueryProvider client={client}>
        <Failing />
      </QueryProvider>,
    );

    // 1 initial attempt + bounded retries, never unbounded.
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1 + QUERY_RETRY_LIMIT), {
      timeout: 15_000,
    });
  });
});

describe('retry policy', () => {
  it.each([401, 403, 404, 400, 409])('never retries HTTP %i', (status) => {
    const error = new ApiClientError({ status, code: 'ANY_CODE' });
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it('never retries deterministic client codes even with an odd status', () => {
    const validation = new ApiClientError({ status: 200, code: 'VALIDATION_ERROR' });
    const auth = new ApiClientError({ status: 0, code: 'UNAUTHENTICATED' });

    expect(shouldRetryQuery(0, validation)).toBe(false);
    expect(shouldRetryQuery(0, auth)).toBe(false);
  });

  it('retries transient failures but stops at the limit', () => {
    const serverError = new ApiClientError({ status: 500, code: 'INTERNAL_ERROR' });
    const network = new ApiClientError({ status: 0, code: 'NETWORK_ERROR' });

    expect(shouldRetryQuery(0, serverError)).toBe(true);
    expect(shouldRetryQuery(0, network)).toBe(true);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT - 1, serverError)).toBe(true);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT, serverError)).toBe(false);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT + 5, network)).toBe(false);
  });
});

describe('query keys', () => {
  it('builds a hierarchical structure for invalidation', () => {
    expect(queryKeys.auth.all()).toStrictEqual(['auth']);
    expect(queryKeys.auth.session()).toStrictEqual(['auth', 'session']);

    expect(queryKeys.events.all()).toStrictEqual(['events']);
    expect(queryKeys.events.list()).toStrictEqual(['events', 'list']);
    expect(queryKeys.events.detail('e1')).toStrictEqual(['events', 'detail', 'e1']);
    expect(queryKeys.events.matches('e1')).toStrictEqual(['events', 'matches', 'e1']);

    expect(queryKeys.matches.detail('m1')).toStrictEqual(['matches', 'detail', 'm1']);
    expect(queryKeys.matches.events('m1')).toStrictEqual(['matches', 'events', 'm1', {}]);
  });

  it('nests match keys under a shared prefix for bulk invalidation', () => {
    const detail = queryKeys.matches.detail('m1');
    const events = queryKeys.matches.events('m1', { limit: 50 });

    expect(detail[0]).toBe('matches');
    expect(events[0]).toBe('matches');
    expect(queryKeys.matches.all()).toStrictEqual(['matches']);
  });

  it('keeps only safe numeric filters in the event-log key', () => {
    const key = queryKeys.matches.events('m1', { limit: 20, beforeSeq: 100 });
    expect(key).toStrictEqual(['matches', 'events', 'm1', { limit: 20, beforeSeq: 100 }]);
  });

  it('never embeds credentials, cookies, or view codes', () => {
    const serialised = JSON.stringify([
      queryKeys.auth.session(),
      queryKeys.events.list(),
      queryKeys.events.detail('e1'),
      queryKeys.events.matches('e1'),
      queryKeys.matches.detail('m1'),
      queryKeys.matches.events('m1', { limit: 10 }),
      queryKeys.matches.result('m1'),
    ]).toLowerCase();

    for (const forbidden of ['viewcode', 'view_code', 'token', 'credential', 'cookie', 'secret']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('does not assume an unimplemented history endpoint', () => {
    expect(JSON.stringify(queryKeys)).not.toContain('history');
  });

  it('supports partial invalidation from the cache', () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.matches.detail('m1'), { id: 'm1' });
    client.setQueryData(queryKeys.matches.events('m1'), { events: [] });
    client.setQueryData(queryKeys.events.list(), { events: [] });

    void client.invalidateQueries({ queryKey: queryKeys.matches.all() });

    expect(client.getQueryState(queryKeys.matches.detail('m1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.matches.events('m1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.events.list())?.isInvalidated).toBe(false);
  });
});
