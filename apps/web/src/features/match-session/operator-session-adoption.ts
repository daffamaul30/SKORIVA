/**
 * Operator session adoption (T-31 remediation C1).
 *
 * Turns the private `operator:session` event into a credential-store transition.
 * Kept as a pure function so the decision is testable without a React tree.
 *
 * Backend facts (`apps/api/src/realtime/resync.ts`, `rooms.ts`):
 * - a credential is only present when it is **issued**: first claim and handover;
 * - a reconnect re-attaches the existing session and sends no credential;
 * - handover issues a new `sessionId`, which is what distinguishes it from a
 *   plain refresh of the same session.
 */

import type { OperatorSessionPayload } from '@/lib/realtime/socket-contract';
import { useOperatorCredentials } from '@/lib/store/operator-credentials.store';

export type SessionAdoptionKind = 'initial' | 'handover' | 'refresh' | 'ignored';

export function adoptOperatorSession(payload: OperatorSessionPayload): SessionAdoptionKind {
  const current = useOperatorCredentials.getState();

  // Another match's session must never touch this store.
  if (current.matchId !== null && current.matchId !== payload.matchId) {
    return 'ignored';
  }

  // Reconnect echoes carry no credential: nothing to adopt, nothing to clear.
  if (!payload.credential) {
    return 'ignored';
  }

  const input = {
    matchId: payload.matchId,
    sessionId: payload.sessionId,
    credential: payload.credential,
    expiresAt: payload.expiresAt,
  };

  if (current.sessionId === null) {
    useOperatorCredentials.getState().setSessionCredential(input);
    return 'initial';
  }

  if (current.sessionId !== payload.sessionId) {
    // Handover: a different session takes over. `controlToken` is untouched.
    useOperatorCredentials.getState().replaceSessionCredential(input);
    return 'handover';
  }

  // Same session re-issued; refresh the proof in place.
  useOperatorCredentials.getState().setSessionCredential(input);
  return 'refresh';
}
