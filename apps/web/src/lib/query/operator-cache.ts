/**
 * Operator-only query cache isolation (T-31.7).
 *
 * Operator-scoped REST data (match event log, operator match detail) must never
 * be visible to a different operator session on the same browser. TanStack Query
 * keys do not contain credentials, so the cache is cleared explicitly on:
 * - credential clearing (revocation/termination),
 * - active match change,
 * - operator session replacement (handover),
 * - ownership revocation.
 */

import type { QueryClient } from '@tanstack/react-query';

/** Key segments that hold operator-scoped data. */
const OPERATOR_SCOPED = new Set(['events', 'detail']);

/**
 * Remove operator-scoped match queries.
 *
 * - with `matchId`: only that match;
 * - without: every match (used when the session is cleared entirely).
 *
 * Public viewer data (`matches.result`) is intentionally preserved.
 */
export function clearOperatorQueryCache(client: QueryClient, matchId?: string): void {
  client.removeQueries({
    predicate: (query) => {
      const [root, scope, id] = query.queryKey as [unknown, unknown, unknown];

      if (root !== 'matches') return false;
      if (typeof scope !== 'string' || !OPERATOR_SCOPED.has(scope)) return false;
      if (matchId === undefined) return true;

      return id === matchId;
    },
  });
}

/** Clear every cached query (used on logout). */
export function clearAllQueryCache(client: QueryClient): void {
  client.clear();
}
