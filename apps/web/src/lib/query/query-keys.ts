/**
 * Query key factory (T-31.3).
 *
 * Keys are hierarchical so a single invalidation can target one level:
 *
 *   ['auth']                            → all auth data
 *   ['auth', 'session']                 → current account
 *   ['events']                          → every event list
 *   ['events', 'detail', eventId]       → one event
 *   ['matches', 'detail', matchId]      → match metadata
 *   ['matches', 'events', matchId, q]   → paginated match event log
 *
 * Two hard rules:
 * - never place `viewCode`, operator credentials, or cookies in a key — keys are
 *   serialised into cache snapshots and devtools;
 * - there is no key for `/api/history` because the backend does not expose it.
 */

export interface MatchEventsQuery {
  limit?: number;
  beforeSeq?: number;
}

/** Query filters that are safe to serialise (no credentials). */
function stableFilters(filters: MatchEventsQuery | undefined): Record<string, number> {
  const entries: Record<string, number> = {};
  if (filters?.limit !== undefined) entries.limit = filters.limit;
  if (filters?.beforeSeq !== undefined) entries.beforeSeq = filters.beforeSeq;
  return entries;
}

export const queryKeys = {
  auth: {
    all: () => ['auth'] as const,
    session: () => ['auth', 'session'] as const,
  },

  events: {
    all: () => ['events'] as const,
    list: () => ['events', 'list'] as const,
    detail: (eventId: string) => ['events', 'detail', eventId] as const,
    matches: (eventId: string) => ['events', 'matches', eventId] as const,
    children: (eventId: string) => ['events', 'children', eventId] as const,
  },

  matches: {
    all: () => ['matches'] as const,
    detail: (matchId: string) => ['matches', 'detail', matchId] as const,
    /** Append-only audit log; operator-session protected on the backend. */
    events: (matchId: string, filters?: MatchEventsQuery) =>
      ['matches', 'events', matchId, stableFilters(filters)] as const,
    /** Public result surface (`GET /api/matches/:id/result`). */
    result: (matchId: string) => ['matches', 'result', matchId] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
