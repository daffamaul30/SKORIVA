/**
 * Socket.IO wire contract (T-31.5).
 *
 * `@skoriva/shared` does **not** export Socket.IO payload types, so they are
 * declared here and verified against the backend source:
 * - `apps/api/src/realtime/serializers.ts` (server → client payloads)
 * - `apps/api/src/realtime/handlers.ts` (client → server payloads + ack shapes)
 * - `apps/api/src/realtime/ticker.ts` (`match:clock`)
 *
 * These are intentionally client-side types: changing shared is out of scope.
 */

import type { MatchState, MatchStatus, ResultDecision, ScoreboardView } from '@skoriva/shared';
import type { MatchActionInput } from '@skoriva/shared';

/** Socket event names actually registered by the backend. */
export const SOCKET_EVENTS = {
  join: 'match:join',
  action: 'match:action',
  clockConfirm: 'clock.confirm',
  leave: 'match:leave',
  handoverCreate: 'operator:handover.create',
  handoverAccept: 'operator:handover.accept',
  rotateToken: 'operator:rotate-token',
  rotateViewCode: 'operator:rotate-view-code',
  pong: 'match:pong',

  snapshot: 'match:snapshot',
  patch: 'match:patch',
  clock: 'match:clock',
  status: 'match:status',
  error: 'match:error',
  operatorState: 'operator:state',
  operatorSession: 'operator:session',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export type RealtimeRole = 'operator' | 'viewer';

/* ------------------------------------------------------------------ */
/* Client → server payloads                                            */
/* ------------------------------------------------------------------ */

/**
 * `match:join`. Exactly one of `token`/`viewCode` selects the role:
 * - `token` = `controlToken` (first claim) **or** `sessionCredential` (reconnect);
 * - `viewCode` = public viewer code.
 */
export interface JoinPayload {
  matchId: string;
  token?: string;
  viewCode?: string;
  /** Echoed by the client; the backend currently always sends a full snapshot. */
  lastVersion?: number;
}

export interface LeavePayload {
  matchId: string;
}

/** `match:action` reuses the shared discriminated union + guards. */
export type ActionPayload = MatchActionInput & { matchId: string };

export interface ClockConfirmPayload {
  matchId: string;
  txId: string;
  expectedVersion: number;
  payload?: Record<string, unknown>;
}

export interface MatchOnlyPayload {
  matchId: string;
}

export interface HandoverAcceptPayload {
  matchId: string;
  code: string;
}

export interface PongPayload {
  ts?: number;
}

/* ------------------------------------------------------------------ */
/* Server → client payloads                                            */
/* ------------------------------------------------------------------ */

/** Operator snapshot: carries internal `state`. */
export interface OperatorSnapshot {
  matchId: string;
  version: number;
  state: MatchState;
  display: ScoreboardView;
  serverTs: string;
}

/**
 * Viewer snapshot: never carries `state`, and omits `display` while the result
 * is not publicly visible (finished-undecided / discarded / cancelled).
 */
export interface ViewerSnapshot {
  matchId: string;
  version: number;
  display?: ScoreboardView;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  serverTs: string;
}

export type MatchSnapshot = OperatorSnapshot | ViewerSnapshot;

/** Operator patch = snapshot + optional triggering event. */
export interface OperatorPatch extends OperatorSnapshot {
  event?: { seq: number; type: string; payload: unknown };
}

export type MatchPatch = OperatorPatch | ViewerSnapshot;

export interface MatchClockPayload {
  matchId: string;
  clock: { remainingMs: number; isRunning: boolean; expired: boolean };
  /** Basketball shot clock, derived from `state.sportState`. */
  sportClock?: { remainingMs: number; running: boolean; expired: boolean };
  serverTs: string;
}

export interface MatchStatusPayload {
  matchId: string;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
}

export interface OperatorStatePayload {
  active: boolean;
  actorRef?: string;
  /** ISO timestamp while the active operator is inside the 30s grace window. */
  graceUntil?: string;
}

/**
 * Private operator session credential delivery.
 * `credential` is only present on issue/replacement, never on reconnect echo.
 */
export interface OperatorSessionPayload {
  matchId: string;
  sessionId: string;
  credential?: string;
  expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Acknowledgements                                                    */
/* ------------------------------------------------------------------ */

export interface AckErrorBody {
  code: string;
  message: string;
  currentVersion?: number;
}

/** `match:error` broadcast: same as ack error plus an optional resync snapshot. */
export interface MatchErrorPayloadShape extends AckErrorBody {
  snapshot?: unknown;
}

/**
 * Validate the opaque `snapshot` carried by `match:error`.
 *
 * The backend sends `toOperatorSnapshot()` (or the viewer variant). Both always
 * have `matchId`, a numeric `version`, and `serverTs`; operator snapshots add
 * `state`, viewer snapshots add `matchStatus`/`resultDecision`.
 */
export function isMatchSnapshot(value: unknown): value is MatchSnapshot {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;

  if (typeof record.matchId !== 'string') return false;
  if (typeof record.version !== 'number') return false;
  if (typeof record.serverTs !== 'string') return false;

  const isOperator = 'state' in record;
  const isViewer = typeof record.matchStatus === 'string';

  return isOperator || isViewer;
}

/** `match:join` success ack. */
export interface JoinAckOk {
  ok: true;
  role: RealtimeRole;
}

/** `match:action` / `clock.confirm` success ack. */
export interface ActionAckOk {
  version: number;
  txId: string;
}

export interface HandoverCreateAck {
  code: string;
  expiresAt: string;
}

export interface HandoverAcceptAck {
  active: true;
}

/** `operator:rotate-token` — replaces the control token only. */
export interface RotateTokenAck {
  controlToken: string;
  issuedAt: string;
}

/** `operator:rotate-view-code` — replaces the viewer code only. */
export interface RotateViewCodeAck {
  viewCode: string;
  issuedAt: string;
}

export interface PongAck {
  ts: number;
}

export interface LeaveAck {
  ok: true;
}
