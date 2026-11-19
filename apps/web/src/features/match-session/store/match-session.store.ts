/**
 * Match session realtime store (T-31.7).
 *
 * Holds **only** realtime operational state that arrives over Socket.IO. REST
 * server state (auth, events, match metadata) stays in TanStack Query; match
 * runtime values are never duplicated into the query cache.
 *
 * Authoritative rules:
 * - a full `match:snapshot` replaces local state;
 * - a `match:patch` is applied only when `version > currentVersion`
 *   (the backend always sends full snapshots, never independent deltas);
 * - nothing here is optimistic: the store only reflects confirmed server data.
 */

import { create } from 'zustand';
import type { MatchStatus, ResultDecision, ScoreboardView } from '@skoriva/shared';
import type {
  MatchClockPayload,
  MatchPatch,
  MatchSnapshot,
  MatchStatusPayload,
  OperatorSnapshot,
  OperatorStatePayload,
  RealtimeRole,
  ViewerSnapshot,
} from '@/lib/realtime/socket-contract';

export type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected';

export interface ClockSnapshot {
  remainingMs: number;
  isRunning: boolean;
  expired: boolean;
  sportClock?: { remainingMs: number; running: boolean; expired: boolean };
  /** Server timestamp of the sample, used as the interpolation anchor. */
  serverTs: string;
}

export interface SessionError {
  code: string;
  message: string;
  currentVersion?: number;
}

export interface MatchSessionState {
  matchId: string | null;
  role: RealtimeRole | null;
  version: number;
  display: ScoreboardView | null;
  matchStatus: MatchStatus | null;
  resultDecision: ResultDecision | null;
  clock: ClockSnapshot | null;
  connection: ConnectionState;
  operatorActive: boolean;
  graceUntil: string | null;
  /** B-11: clock frozen until the operator confirms. */
  recoveryPending: boolean;
  lastError: SessionError | null;

  startSession(matchId: string, role: RealtimeRole): void;
  reset(): void;
  applySnapshot(payload: MatchSnapshot): void;
  /**
   * Apply a recovery snapshot from `match:error` only when it is newer than the
   * local version. Returns true when applied; stale snapshots are ignored so a
   * late error can never roll state backwards.
   */
  resyncFromSnapshot(payload: MatchSnapshot): boolean;
  /** Returns true when the patch was applied (newer version). */
  applyPatch(payload: MatchPatch): boolean;
  applyStatus(payload: MatchStatusPayload): void;
  applyClock(payload: MatchClockPayload): void;
  setConnection(connection: ConnectionState): void;
  setOperatorState(payload: OperatorStatePayload): void;
  setRecoveryPending(pending: boolean): void;
  setError(error: SessionError | null): void;
}

const EMPTY = {
  matchId: null,
  role: null,
  version: 0,
  display: null,
  matchStatus: null,
  resultDecision: null,
  clock: null,
  connection: 'idle',
  operatorActive: false,
  graceUntil: null,
  recoveryPending: false,
  lastError: null,
} as const;

function isOperatorSnapshot(payload: MatchSnapshot): payload is OperatorSnapshot {
  return 'state' in payload;
}

function clockFromOperatorSnapshot(payload: OperatorSnapshot): ClockSnapshot {
  const clock = payload.state.clock;

  return {
    remainingMs: clock.remainingMs,
    isRunning: clock.isRunning,
    expired: false,
    serverTs: payload.serverTs,
  };
}

export const useMatchSession = create<MatchSessionState>()((set, get) => ({
  ...EMPTY,

  startSession(matchId, role) {
    // A new match starts from a clean slate; a snapshot follows immediately.
    set({ ...EMPTY, matchId, role });
  },

  reset() {
    set({ ...EMPTY });
  },

  applySnapshot(payload) {
    const recoveryPending = isOperatorSnapshot(payload)
      ? payload.state.clock.recoveryPending
      : get().recoveryPending;

    set({
      matchId: payload.matchId,
      version: payload.version,
      display: payload.display ?? null,
      ...(isOperatorSnapshot(payload)
        ? {
            clock: clockFromOperatorSnapshot(payload),
            matchStatus: payload.display.matchStatus,
            resultDecision: payload.display.resultDecision,
          }
        : {
            matchStatus: payload.matchStatus,
            resultDecision: payload.resultDecision,
          }),
      recoveryPending,
      lastError: null,
    });
  },

  resyncFromSnapshot(payload) {
    if (payload.version <= get().version) {
      return false;
    }

    get().applySnapshot(payload);
    return true;
  },

  applyPatch(payload) {
    const current = get();
    // Stale or duplicate patch: keep the authoritative local version.
    if (payload.version <= current.version) {
      return false;
    }

    if (isOperatorSnapshot(payload)) {
      set({
        matchId: payload.matchId,
        version: payload.version,
        display: payload.display,
        matchStatus: payload.display.matchStatus,
        resultDecision: payload.display.resultDecision,
        clock: clockFromOperatorSnapshot(payload),
        recoveryPending: payload.state.clock.recoveryPending,
      });
      return true;
    }

    const viewer = payload as ViewerSnapshot;
    set({
      matchId: viewer.matchId,
      version: viewer.version,
      display: viewer.display ?? null,
      matchStatus: viewer.matchStatus,
      resultDecision: viewer.resultDecision,
    });
    return true;
  },

  applyStatus(payload) {
    set({
      matchStatus: payload.matchStatus,
      resultDecision: payload.resultDecision,
    });
  },

  applyClock(payload) {
    set({
      clock: {
        remainingMs: payload.clock.remainingMs,
        isRunning: payload.clock.isRunning,
        expired: payload.clock.expired,
        ...(payload.sportClock ? { sportClock: payload.sportClock } : {}),
        serverTs: payload.serverTs,
      },
    });
  },

  setConnection(connection) {
    set({ connection });
  },

  setOperatorState(payload) {
    set({
      operatorActive: payload.active,
      graceUntil: payload.graceUntil ?? null,
    });
  },

  setRecoveryPending(recoveryPending) {
    set({ recoveryPending });
  },

  setError(lastError) {
    set({ lastError });
  },
}));

/* ------------------------------ selectors ------------------------------ */

/**
 * Operator controls are enabled only with an operator role, an active session,
 * and a live socket. There is no REST fallback when the socket is down.
 */
export function selectCanOperate(state: MatchSessionState): boolean {
  return (
    state.role === 'operator' &&
    state.connection === 'connected' &&
    state.operatorActive
  );
}

/** True when the clock must not tick locally (B-11 recovery freeze). */
export function selectClockFrozen(state: MatchSessionState): boolean {
  return state.recoveryPending || state.clock?.isRunning !== true || state.clock.expired;
}
