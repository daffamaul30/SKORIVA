/**
 * Match session binding (T-31.7, join guard in T-31 remediation R2).
 *
 * Wires a `SocketClient` to the realtime store:
 * - subscribes before joining (subscribe-then-sync; the backend replies with a
 *   full snapshot);
 * - re-joins on every (re)connect so a dropped socket recovers its snapshot;
 * - never issues REST calls — lifecycle is a separate concern.
 *
 * Credential choice mirrors the backend:
 * - operator reconnect → `sessionCredential`;
 * - operator first claim → `controlToken`;
 * - viewer → `viewCode`.
 *
 * Join guard: concurrent join attempts for the same session share one in-flight
 * promise. A disconnect invalidates the guard, so the next connect starts a fresh
 * join instead of reusing a promise tied to a dead socket.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { isSocketClientError, toSocketError } from '@/lib/realtime/socket-errors';
import type { RealtimeRole } from '@/lib/realtime/socket-contract';
import { isMatchSnapshot } from '@/lib/realtime/socket-contract';
import { useOperatorCredentials } from '@/lib/store/operator-credentials.store';
import { adoptOperatorSession } from '../operator-session-adoption';
import {
  selectCanOperate,
  selectClockFrozen,
  useMatchSession as useMatchSessionStore,
} from '../store/match-session.store';

export interface SessionCredentials {
  controlToken?: string;
  sessionCredential?: string;
  viewCode?: string;
}

export interface UseMatchSessionOptions {
  socket: SocketClient;
  matchId: string;
  role: RealtimeRole;
  credentials: SessionCredentials;
  /** Skip the automatic join (tests, or when the caller joins manually). */
  autoJoin?: boolean;
}

/** Pick the join credential for the role, preferring an active session. */
export function resolveJoinCredential(
  role: RealtimeRole,
  credentials: SessionCredentials,
): { token?: string; viewCode?: string } {
  if (role === 'viewer') {
    return credentials.viewCode ? { viewCode: credentials.viewCode } : {};
  }

  const token = credentials.sessionCredential ?? credentials.controlToken;

  return token ? { token } : {};
}

export function useMatchSession({
  socket,
  matchId,
  role,
  credentials,
  autoJoin = true,
}: UseMatchSessionOptions) {
  const startSession = useMatchSessionStore((state) => state.startSession);
  const applySnapshot = useMatchSessionStore((state) => state.applySnapshot);
  const applyPatch = useMatchSessionStore((state) => state.applyPatch);
  const applyStatus = useMatchSessionStore((state) => state.applyStatus);
  const applyClock = useMatchSessionStore((state) => state.applyClock);
  const resyncFromSnapshot = useMatchSessionStore((state) => state.resyncFromSnapshot);
  const setConnection = useMatchSessionStore((state) => state.setConnection);
  const setOperatorState = useMatchSessionStore((state) => state.setOperatorState);
  const setError = useMatchSessionStore((state) => state.setError);

  // Keep the latest credential snapshot without re-subscribing every render.
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;

  const joinStateRef = useRef<{ promise: Promise<void>; generation: number } | null>(null);
  const generationRef = useRef(0);

  const join = useCallback((): Promise<void> => {
    const existing = joinStateRef.current;
    if (existing) return existing.promise;

    const generation = generationRef.current;

    const promise = (async (): Promise<void> => {
      const payload = resolveJoinCredential(role, credentialsRef.current);
      const result = await socket.join({ matchId, ...payload });

      if (!result.ok) {
        setError({
          code: result.error.code,
          message: result.error.message,
          ...(result.error.currentVersion !== undefined
            ? { currentVersion: result.error.currentVersion }
            : {}),
        });
      }
    })().finally(() => {
      // Only clear the guard if no newer join replaced it.
      if (joinStateRef.current?.generation === generation) {
        joinStateRef.current = null;
      }
    });

    joinStateRef.current = { promise, generation };

    return promise;
  }, [socket, matchId, role, setError]);

  /** A disconnect invalidates any in-flight join tied to the dead socket. */
  const invalidateJoin = useCallback(() => {
    generationRef.current += 1;
    joinStateRef.current = null;
  }, []);

  useEffect(() => {
    startSession(matchId, role);

    const offSnapshot = socket.onSnapshot((payload) => applySnapshot(payload));
    const offPatch = socket.onPatch((payload) => applyPatch(payload));
    const offClock = socket.onClock((payload) => applyClock(payload));
    const offStatus = socket.onStatus((payload) => applyStatus(payload));
    const offOperatorState = socket.onOperatorState((payload) => {
      setOperatorState(payload);

      // Revocation: this operator is no longer active. Drop the REST proof but
      // keep ownership (`controlToken`), which is a different credential.
      if (!payload.active && role === 'operator') {
        useOperatorCredentials.getState().clearSessionCredential();
      }
    });
    const offOperatorSession = socket.onOperatorSession((payload) => {
      if (payload.matchId !== matchId) return;
      adoptOperatorSession(payload);
    });
    const offError = socket.onMatchError((payload) => {
      const error = toSocketError(payload);

      // The backend sends the recovery snapshot on `match:error`, never on the
      // acknowledgement. Apply it only when it is newer than local state, and
      // do it before recording the error so the resync cannot clear it.
      if (error.code === 'VERSION_CONFLICT' && isMatchSnapshot(error.snapshot)) {
        resyncFromSnapshot(error.snapshot);
      }

      setError(error);
    });

    const offConnect = socket.onConnect(() => {
      setConnection('connected');
      void join();
    });
    const offReconnecting = socket.onReconnecting(() => setConnection('reconnecting'));
    const offDisconnect = socket.onDisconnect(() => {
      setConnection('disconnected');
      invalidateJoin();
    });
    const offConnectError = socket.onConnectError((error) => {
      setConnection('disconnected');
      invalidateJoin();
      if (isSocketClientError(error)) setError(error);
    });

    setConnection(socket.connected ? 'connected' : 'idle');
    if (autoJoin && socket.connected) {
      void join();
    }

    return () => {
      offSnapshot();
      offPatch();
      offClock();
      offStatus();
      offOperatorState();
      offOperatorSession();
      offError();
      offConnect();
      offReconnecting();
      offDisconnect();
      offConnectError();
      invalidateJoin();
    };
  }, [
    socket,
    matchId,
    role,
    autoJoin,
    join,
    invalidateJoin,
    startSession,
    applySnapshot,
    applyPatch,
    applyStatus,
    applyClock,
    resyncFromSnapshot,
    setConnection,
    setOperatorState,
    setError,
  ]);

  const state = useMatchSessionStore();

  return {
    state,
    canOperate: selectCanOperate(state),
    clockFrozen: selectClockFrozen(state),
    join,
  };
}
