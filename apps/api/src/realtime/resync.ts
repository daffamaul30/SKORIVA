/**
 * Reconnect resync (T-27, Tech Spec §4.3).
 *
 * Subscribe-then-sync: the room is joined first, then the authoritative
 * snapshot is sent. The client ignores patches with `version <= snapshot.version`.
 * Delta delivery is optional and intentionally not implemented in the MVP.
 */

import type { MatchDocument } from '../models/index.js';
import type { ClientRef, RealtimeGateway, RealtimeRole } from './gateway.js';
import type { JoinResult, RoomManager } from './rooms.js';
import {
  toMatchErrorPayload,
  toOperatorSessionPayload,
  toOperatorSnapshot,
  toOperatorStatePayload,
  toViewerSnapshot,
} from './serializers.js';

export interface JoinPayload {
  matchId: string;
  token?: string;
  viewCode?: string;
  lastVersion?: number;
}

export interface ResyncDeps {
  rooms: RoomManager;
  gateway: RealtimeGateway;
  now: () => Date;
}

function operatorStateFromMatch(
  match: MatchDocument,
  now: Date,
): { active: boolean; actorRef?: string; graceUntil?: Date } {
  const session = match.access.operatorSession;
  const graceExpired =
    match.operatorGraceUntil !== undefined && match.operatorGraceUntil.getTime() <= now.getTime();
  const active = Boolean(
    session &&
    session.revokedAt === undefined &&
    match.activeOperatorId === session.sessionId &&
    !graceExpired,
  );

  return {
    active,
    ...(match.activeOperatorId ? { actorRef: match.activeOperatorId } : {}),
    ...(match.operatorGraceUntil ? { graceUntil: match.operatorGraceUntil } : {}),
  };
}

export function sendSnapshot(
  clientRef: ClientRef,
  match: MatchDocument,
  role: RealtimeRole,
  gateway: RealtimeGateway,
  now = new Date(),
): void {
  gateway.emitTo(
    clientRef,
    'match:snapshot',
    role === 'operator' ? toOperatorSnapshot(match, now) : toViewerSnapshot(match, now),
  );
}

/** Join the room first, then send the role-scoped snapshot. */
export async function joinAndSync(
  clientRef: ClientRef,
  payload: JoinPayload,
  deps: ResyncDeps,
): Promise<JoinResult> {
  const result = payload.token
    ? await deps.rooms.joinOperator(clientRef, payload.matchId, payload.token)
    : await deps.rooms.joinViewer(clientRef, payload.matchId, payload.viewCode);

  if (!result.ok) {
    deps.gateway.emitTo(
      clientRef,
      'match:error',
      toMatchErrorPayload({ code: result.code, message: result.message }),
    );
    return result;
  }

  const now = deps.now();

  if (result.role === 'operator') {
    deps.gateway.emitTo(clientRef, 'match:snapshot', toOperatorSnapshot(result.match, now));

    if (result.sessionIssue) {
      deps.gateway.emitTo(
        clientRef,
        'operator:session',
        toOperatorSessionPayload({
          matchId: payload.matchId,
          sessionId: result.sessionIssue.sessionId,
          credential: result.sessionIssue.credential,
          expiresAt: result.sessionIssue.expiresAt,
        }),
      );
    }
  } else {
    deps.gateway.emitTo(clientRef, 'match:snapshot', toViewerSnapshot(result.match, now));
    deps.gateway.emitTo(
      clientRef,
      'operator:state',
      toOperatorStatePayload(operatorStateFromMatch(result.match, now)),
    );
  }

  return result;
}
