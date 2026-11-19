/**
 * Transport-agnostic realtime gateway (T-24, Tech Spec §3.4).
 *
 * The gateway only moves payloads; it never computes state. `join`, `leave`,
 * and `disconnectRole` manage room membership; `broadcast*` emit to the match
 * room or a role-scoped room; `emitTo` sends a private message.
 */

export type RealtimeRole = 'operator' | 'viewer';
export type RoleFilter = RealtimeRole | 'all';
export type ClientRef = string;

export interface RealtimeGateway {
  join(matchId: string, clientRef: ClientRef, role: RealtimeRole): void;
  leave(matchId: string, clientRef: ClientRef): void;
  /** Disconnect every client in a role room; used by view-code rotation (R-04). */
  disconnectRole(matchId: string, role: RealtimeRole): void;
  broadcastPatch(matchId: string, payload: unknown, roleFilter: RoleFilter): void;
  broadcastClock(matchId: string, payload: unknown): void;
  broadcastStatus(matchId: string, payload: unknown): void;
  broadcastOperatorState(matchId: string, payload: unknown): void;
  emitTo(clientRef: ClientRef, event: string, payload: unknown): void;
}

export function matchRoom(matchId: string): string {
  return `match:${matchId}`;
}

export function roleRoom(matchId: string, role: RealtimeRole): string {
  return `match:${matchId}:${role}`;
}
