/**
 * T-31.7 — Operator query cache isolation.
 *
 * Operator-scoped data must not survive a credential change, while public viewer
 * data and account data stay intact.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/query/query-keys';
import { clearAllQueryCache, clearOperatorQueryCache } from '@/lib/query/operator-cache';

function seededClient(): QueryClient {
  const client = new QueryClient();

  client.setQueryData(queryKeys.matches.detail('m-1'), { id: 'm-1' });
  client.setQueryData(queryKeys.matches.events('m-1'), { events: [] });
  client.setQueryData(queryKeys.matches.result('m-1'), { matchStatus: 'finished' });
  client.setQueryData(queryKeys.matches.detail('m-2'), { id: 'm-2' });
  client.setQueryData(queryKeys.events.list(), { events: [] });
  client.setQueryData(queryKeys.auth.session(), { id: 'acc-1' });

  return client;
}

describe('clearOperatorQueryCache', () => {
  it('removes operator-scoped data for one match only', () => {
    const client = seededClient();

    clearOperatorQueryCache(client, 'm-1');

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    // Public result survives: it is viewer data, not operator data.
    expect(client.getQueryData(queryKeys.matches.result('m-1'))).toBeDefined();
    // Another match is untouched.
    expect(client.getQueryData(queryKeys.matches.detail('m-2'))).toBeDefined();
    // Account data is never operator-scoped.
    expect(client.getQueryData(queryKeys.events.list())).toBeDefined();
    expect(client.getQueryData(queryKeys.auth.session())).toBeDefined();
  });

  it('removes operator-scoped data for every match when no id is given', () => {
    const client = seededClient();

    clearOperatorQueryCache(client);

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.detail('m-2'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.result('m-1'))).toBeDefined();
    expect(client.getQueryData(queryKeys.events.list())).toBeDefined();
  });

  it('keeps every event-log page variant of the same match', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.matches.events('m-1', { limit: 20 }), { events: [] });
    client.setQueryData(queryKeys.matches.events('m-1', { limit: 50, beforeSeq: 100 }), {
      events: [],
    });

    clearOperatorQueryCache(client, 'm-1');

    expect(client.getQueryData(queryKeys.matches.events('m-1', { limit: 20 }))).toBeUndefined();
    expect(
      client.getQueryData(queryKeys.matches.events('m-1', { limit: 50, beforeSeq: 100 })),
    ).toBeUndefined();
  });

  it('clearAllQueryCache drops everything on logout', () => {
    const client = seededClient();

    clearAllQueryCache(client);

    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
