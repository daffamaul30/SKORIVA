/**
 * Automatic operator cache isolation (T-31 remediation R3).
 *
 * Operator-only REST data must never survive an operator session change. This
 * installer subscribes to both stores imperatively, so isolation happens without
 * any component or UI having to call it.
 *
 * Paths that clear operator-scoped cache:
 * 1. credentials cleared (`clearCredentials`) — revocation/termination;
 * 2. active match changed;
 * 3. operator session replaced (`operator:session`, `operator:handover.accept`);
 * 4. operator loses operational rights (`operator:state { active: false }`).
 *
 * Public data is preserved: `matches.result` (viewer), `events.*`, and `auth.*`.
 * Credentials are never part of a query key, so isolation is explicit.
 */

import type { QueryClient } from '@tanstack/react-query';
import { useOperatorCredentials } from '@/lib/store/operator-credentials.store';
import { clearOperatorQueryCache } from '@/lib/query/operator-cache';
import { useMatchSession } from './store/match-session.store';

interface IsolationSnapshot {
  matchId: string | null;
  sessionId: string | null;
  hasSessionCredential: boolean;
  operatorActive: boolean;
  role: string | null;
}

function readSnapshot(): IsolationSnapshot {
  const credentials = useOperatorCredentials.getState();
  const session = useMatchSession.getState();

  return {
    matchId: credentials.matchId,
    sessionId: credentials.sessionId,
    hasSessionCredential: credentials.sessionCredential !== null,
    operatorActive: session.operatorActive,
    role: session.role,
  };
}

function clearFor(queryClient: QueryClient, matchId: string | null): void {
  if (!matchId) return;

  clearOperatorQueryCache(queryClient, matchId);
}

/**
 * Decide which cache to clear for one state transition.
 *
 * Returns the match ids to clear; empty when nothing operator-scoped changed.
 */
export function resolveIsolationTargets(
  previous: IsolationSnapshot,
  next: IsolationSnapshot,
): string[] {
  const targets = new Set<string>();

  // 1. Active match changed: both sides are operator-scoped.
  if (previous.matchId !== next.matchId) {
    if (previous.matchId) targets.add(previous.matchId);
    if (next.matchId) targets.add(next.matchId);
    return [...targets];
  }

  // 2. Operator session replaced (handover, new `operator:session`).
  if (previous.sessionId !== null && previous.sessionId !== next.sessionId) {
    if (next.matchId) targets.add(next.matchId);
  }

  // 3. Credentials cleared (revocation / termination).
  if (previous.hasSessionCredential && !next.hasSessionCredential) {
    if (previous.matchId) targets.add(previous.matchId);
  }

  // 4. Operator lost operational rights while still the operator.
  if (
    previous.operatorActive &&
    !next.operatorActive &&
    (next.role === 'operator' || previous.role === 'operator')
  ) {
    if (next.matchId ?? previous.matchId) {
      targets.add((next.matchId ?? previous.matchId) as string);
    }
  }

  return [...targets];
}

/**
 * Install automatic isolation. Call once per QueryClient (the provider does it).
 * Returns a disposer for cleanup/tests.
 */
export function installOperatorCacheIsolation(queryClient: QueryClient): () => void {
  let previous = readSnapshot();

  const check = (): void => {
    const next = readSnapshot();
    const targets = resolveIsolationTargets(previous, next);

    for (const matchId of targets) {
      clearFor(queryClient, matchId);
    }

    previous = next;
  };

  const unsubscribeCredentials = useOperatorCredentials.subscribe(check);
  const unsubscribeSession = useMatchSession.subscribe(check);

  return () => {
    unsubscribeCredentials();
    unsubscribeSession();
  };
}
