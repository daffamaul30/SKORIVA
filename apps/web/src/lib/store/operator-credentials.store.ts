/**
 * Operator credential store (T-31.6).
 *
 * Two credentials are kept **separate on purpose**:
 * - `controlToken` — ownership credential: initial claim and (per backend) the
 *   only token that `operator:rotate-token` replaces;
 * - `sessionCredential` — active operator session proof: the `X-Operator-Session`
 *   header value for REST lifecycle calls and the reconnect credential.
 *
 * Rules:
 * - in-memory only: no `persist` middleware, no localStorage/sessionStorage,
 *   no cookies, no logging;
 * - rotating the control token must never overwrite the session credential;
 * - a successful handover replaces the *receiving* operator's session credential;
 * - clearing is explicit (revocation, termination, match change).
 */

import { create } from 'zustand';

export interface OperatorSessionInput {
  matchId: string;
  sessionId: string;
  credential: string;
  expiresAt: string;
}

export interface ControlTokenInput {
  matchId: string;
  controlToken: string;
}

export interface OperatorCredentialsState {
  matchId: string | null;
  controlToken: string | null;
  sessionCredential: string | null;
  sessionId: string | null;
  expiresAt: string | null;

  /** First join: the create-match `controlToken` is the only credential. */
  setInitialControlToken(input: ControlTokenInput): void;
  /** Private `operator:session` event after a successful claim. */
  setSessionCredential(input: OperatorSessionInput): void;
  /** `operator:rotate-token` ack — replaces the control token only. */
  rotateControlToken(input: ControlTokenInput): void;
  /** Successful `operator:handover.accept` — replaces the session credential. */
  replaceSessionCredential(input: OperatorSessionInput): void;
  /**
   * Revocation of the *session* (not ownership): drops the REST proof and the
   * session id while keeping `controlToken`, which remains valid ownership.
   */
  clearSessionCredential(): void;
  /** Revocation, termination, or leaving the match. */
  clearCredentials(): void;
}

const EMPTY = {
  matchId: null,
  controlToken: null,
  sessionCredential: null,
  sessionId: null,
  expiresAt: null,
} as const;

export const useOperatorCredentials = create<OperatorCredentialsState>()((set, get) => ({
  ...EMPTY,

  setInitialControlToken({ matchId, controlToken }) {
    // A different match invalidates every previous credential.
    if (get().matchId !== null && get().matchId !== matchId) {
      set({ ...EMPTY, matchId, controlToken });
      return;
    }

    set({ matchId, controlToken });
  },

  setSessionCredential({ matchId, sessionId, credential, expiresAt }) {
    set({ matchId, sessionId, sessionCredential: credential, expiresAt });
  },

  rotateControlToken({ matchId, controlToken }) {
    // Guard: a rotation for another match must not clobber this session.
    if (get().matchId !== null && get().matchId !== matchId) {
      return;
    }

    set({ matchId, controlToken });
  },

  replaceSessionCredential({ matchId, sessionId, credential, expiresAt }) {
    set({ matchId, sessionId, sessionCredential: credential, expiresAt });
  },

  clearSessionCredential() {
    // Ownership (`controlToken`) is intentionally preserved: losing the active
    // session does not revoke ownership, and clearing it would prevent reclaim.
    set({ sessionCredential: null, sessionId: null, expiresAt: null });
  },

  clearCredentials() {
    set({ ...EMPTY });
  },
}));

/* --------------------------- derived selectors --------------------------- */

/** True when the operator can send REST lifecycle calls. */
export function selectHasSessionCredential(state: OperatorCredentialsState): boolean {
  return state.sessionCredential !== null;
}

/** True when the operator could attempt a first claim. */
export function selectHasControlToken(state: OperatorCredentialsState): boolean {
  return state.controlToken !== null;
}

/**
 * Session status for a future UI. Credentials vanish on refresh by design, so
 * `'unauthenticated'` is the expected state after a reload (OQ #1 unresolved).
 */
export function selectSessionStatus(
  state: OperatorCredentialsState,
): 'active' | 'claim-available' | 'unauthenticated' {
  if (state.sessionCredential !== null) return 'active';
  if (state.controlToken !== null) return 'claim-available';
  return 'unauthenticated';
}

/**
 * Read the current REST proof at call time.
 *
 * Callers must invoke this when the request is made (never at module import or
 * inside a stale closure) so rotation/handover is always reflected.
 */
export function getSessionCredential(): string | null {
  return useOperatorCredentials.getState().sessionCredential;
}
