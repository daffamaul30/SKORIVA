/**
 * Operator action hook (T-31.7).
 *
 * Operational actions travel over Socket.IO only — there is no REST fallback
 * (B-06). Each call carries `txId` and the current `expectedVersion`; the store
 * is never mutated optimistically.
 *
 * On `VERSION_CONFLICT` the backend sends the recovery snapshot through the
 * `match:error` broadcast (never through the acknowledgement). `useMatchSession`
 * applies it; this hook only surfaces the error to the caller.
 */

import { useCallback } from 'react';
import type { MatchAction } from '@skoriva/shared';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { useMatchSession } from '../store/match-session.store';
import { createTxId } from '../store/tx-id';

export interface OperatorActionResult {
  ok: boolean;
  version?: number;
  code?: string;
  message?: string;
}

export interface UseOperatorActionOptions {
  socket: SocketClient;
  matchId: string;
}

export function useOperatorAction({ socket, matchId }: UseOperatorActionOptions) {
  const version = useMatchSession((state) => state.version);
  const setError = useMatchSession((state) => state.setError);

  const send = useCallback(
    async (action: MatchAction): Promise<OperatorActionResult> => {
      const txId = createTxId();

      const result = await socket.sendAction({
        matchId,
        txId,
        expectedVersion: version,
        ...action,
      } as Parameters<SocketClient['sendAction']>[0]);

      if (result.ok) {
        return { ok: true, version: result.data.version };
      }

      setError({
        code: result.error.code,
        message: result.error.message,
        ...(result.error.currentVersion !== undefined
          ? { currentVersion: result.error.currentVersion }
          : {}),
      });

      return {
        ok: false,
        code: result.error.code,
        message: result.error.message,
        ...(result.error.currentVersion !== undefined
          ? { version: result.error.currentVersion }
          : {}),
      };
    },
    [socket, matchId, version, setError],
  );

  /** Confirms a recovered clock (B-11); the server restarts the clock. */
  const confirmClock = useCallback(
    async (remainingMs?: number): Promise<OperatorActionResult> => {
      const result = await socket.confirmClock({
        matchId,
        txId: createTxId(),
        expectedVersion: version,
        ...(remainingMs !== undefined ? { payload: { remainingMs } } : {}),
      });

      if (result.ok) return { ok: true, version: result.data.version };

      setError({ code: result.error.code, message: result.error.message });

      return { ok: false, code: result.error.code, message: result.error.message };
    },
    [socket, matchId, version, setError],
  );

  return { send, confirmClock };
}
