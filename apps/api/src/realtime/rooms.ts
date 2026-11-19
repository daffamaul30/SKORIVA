/**
 * Match room manager (T-25).
 *
 * Owns room membership, operator/viewer access, socket-to-session context, the
 * 30 second operator grace window, and the configurable grace sweeper. Lazy
 * expiration remains the source of truth for claims/actions; the sweeper only
 * cleans up and broadcasts `operator:state`.
 */

import type { MatchDocument } from '../models/index.js';
import type { LoadedMatchWithEvents } from '../repositories/match.repo.js';
import {
  claimOperatorSession,
  expireOperatorGraceIfNeeded,
  findExpiredOperatorGraceMatches,
  markOperatorDisconnected,
  OperatorSessionError,
  reconnectOperatorSession,
} from '../access/operator-session.js';
import { resolveOperatorAccess, resolveViewerAccess } from '../access/guard.js';
import type { ClientRef, RealtimeGateway, RealtimeRole } from './gateway.js';
import { toOperatorSessionPayload, toOperatorStatePayload } from './serializers.js';

export const DEFAULT_GRACE_SWEEP_INTERVAL_MS = 5_000;

export interface SocketContext {
  clientRef: ClientRef;
  matchId: string;
  role: RealtimeRole;
  operatorCredential?: string;
  sessionId?: string;
}

export interface IssuedSession {
  sessionId: string;
  credential: string;
  expiresAt: Date;
}

export type JoinResult =
  | {
      ok: true;
      role: RealtimeRole;
      match: MatchDocument;
      sessionIssue?: IssuedSession;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export interface RoomManagerDeps {
  gateway: RealtimeGateway;
  pepper: string;
  loadMatch: (matchId: string) => Promise<LoadedMatchWithEvents | null>;
  now: () => Date;
  graceSweepIntervalMs: number;
}

export class RoomManager {
  private readonly contexts = new Map<ClientRef, SocketContext>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RoomManagerDeps) {}

  getContext(clientRef: ClientRef): SocketContext | undefined {
    return this.contexts.get(clientRef);
  }

  isActiveOperator(clientRef: ClientRef, matchId: string): boolean {
    const context = this.contexts.get(clientRef);
    return context?.role === 'operator' && context.matchId === matchId;
  }

  /**
   * Join as operator.
   *
   * Operator session credentials are verified first. A recognized credential
   * that is revoked/expired/stale is rejected and never falls back to the
   * control-token claim path. Only an unknown credential (INVALID) is treated as
   * a possible control token.
   */
  async joinOperator(
    clientRef: ClientRef,
    matchId: string,
    token: string | undefined,
  ): Promise<JoinResult> {
    const now = this.deps.now();
    const loaded = await this.deps.loadMatch(matchId);

    if (!loaded) {
      return { ok: false, code: 'MATCH_NOT_FOUND', message: 'Match not found.' };
    }

    if (!token) {
      return {
        ok: false,
        code: 'OPERATOR_SESSION_REQUIRED',
        message: 'An operator token is required.',
      };
    }

    try {
      const reconnected = await reconnectOperatorSession(matchId, token, this.deps.pepper, now);

      this.attach(clientRef, {
        matchId,
        role: 'operator',
        operatorCredential: token,
        sessionId: reconnected.session.sessionId,
      });

      return { ok: true, role: 'operator', match: reconnected.match };
    } catch (error) {
      if (!(error instanceof OperatorSessionError)) throw error;

      if (error.code !== 'OPERATOR_SESSION_INVALID') {
        return { ok: false, code: error.code, message: error.message };
      }

      // Not a session credential. It may be the control token.
      const grant = await resolveOperatorAccess(matchId, token, this.deps.pepper);

      if (!grant) {
        return {
          ok: false,
          code: 'OPERATOR_SESSION_INVALID',
          message: 'Operator credential is not valid.',
        };
      }

      try {
        const claimed = await claimOperatorSession(matchId, this.deps.pepper, now);

        this.attach(clientRef, {
          matchId,
          role: 'operator',
          operatorCredential: claimed.credential,
          sessionId: claimed.sessionId,
        });

        return {
          ok: true,
          role: 'operator',
          match: loaded.match,
          sessionIssue: {
            sessionId: claimed.sessionId,
            credential: claimed.credential,
            expiresAt: claimed.expiresAt,
          },
        };
      } catch (claimError) {
        if (!(claimError instanceof OperatorSessionError)) throw claimError;

        this.deps.gateway.emitTo(
          clientRef,
          'operator:state',
          toOperatorStatePayload({ active: false }),
        );

        return { ok: false, code: claimError.code, message: claimError.message };
      }
    }
  }

  /** Join as viewer using a view code bound to this match. */
  async joinViewer(
    clientRef: ClientRef,
    matchId: string,
    viewCode: string | undefined,
  ): Promise<JoinResult> {
    if (!viewCode) {
      return { ok: false, code: 'VIEW_CODE_REQUIRED', message: 'A viewer code is required.' };
    }

    const grant = await resolveViewerAccess(matchId, viewCode, this.deps.pepper);

    if (!grant) {
      return {
        ok: false,
        code: 'VIEW_CODE_INVALID',
        message: 'Viewer code is not valid for this match.',
      };
    }

    this.attach(clientRef, { matchId, role: 'viewer' });
    return { ok: true, role: 'viewer', match: grant.match };
  }

  /** Leave one match; an operator keeps the lock for the grace window. */
  async leave(clientRef: ClientRef, matchId?: string): Promise<void> {
    const context = this.contexts.get(clientRef);

    if (!context || (matchId && context.matchId !== matchId)) return;

    this.deps.gateway.leave(context.matchId, clientRef);
    this.contexts.delete(clientRef);

    if (context.role === 'operator' && context.operatorCredential) {
      try {
        const graceUntil = await markOperatorDisconnected(
          context.matchId,
          context.operatorCredential,
          this.deps.pepper,
          this.deps.now(),
        );

        this.broadcastOperatorState(context.matchId, {
          active: true,
          actorRef: context.sessionId,
          graceUntil,
        });
      } catch {
        // The session was already replaced/revoked; its disconnect must not
        // touch the new active session.
      }
    }
  }

  /** Socket disconnect: same as leave, but the socket is already gone. */
  async disconnect(clientRef: ClientRef): Promise<void> {
    await this.leave(clientRef);
  }

  /** Promote a socket after a successful handover accept. */
  adoptOperator(clientRef: ClientRef, matchId: string, session: IssuedSession): void {
    const previous = this.contexts.get(clientRef);
    if (previous && previous.matchId !== matchId) {
      this.deps.gateway.leave(previous.matchId, clientRef);
    }

    this.attach(clientRef, {
      matchId,
      role: 'operator',
      operatorCredential: session.credential,
      sessionId: session.sessionId,
    });

    this.deps.gateway.emitTo(
      clientRef,
      'operator:session',
      toOperatorSessionPayload({
        matchId,
        sessionId: session.sessionId,
        credential: session.credential,
        expiresAt: session.expiresAt,
      }),
    );
  }

  /** Remove every prior operator socket for a match (handover). */
  evictOperators(matchId: string, exceptSessionId?: string): void {
    for (const [clientRef, context] of this.contexts) {
      if (
        context.matchId === matchId &&
        context.role === 'operator' &&
        context.sessionId !== exceptSessionId
      ) {
        this.deps.gateway.leave(matchId, clientRef);
        this.deps.gateway.emitTo(
          clientRef,
          'operator:state',
          toOperatorStatePayload({ active: false }),
        );
        this.contexts.delete(clientRef);
      }
    }
  }

  /** Disconnect all viewers for a match after view-code rotation (R-04). */
  evictViewers(matchId: string): void {
    for (const [clientRef, context] of this.contexts) {
      if (context.matchId === matchId && context.role === 'viewer') {
        this.contexts.delete(clientRef);
      }
    }

    this.deps.gateway.disconnectRole(matchId, 'viewer');
  }

  startGraceSweeper(): void {
    if (this.sweeper) return;

    this.sweeper = setInterval(() => {
      void this.sweepGrace().catch((error: unknown) => {
        console.error(
          '[realtime] grace sweep failed',
          error instanceof Error ? error.message : 'unknown error',
        );
      });
    }, this.deps.graceSweepIntervalMs);
    this.sweeper.unref?.();
  }

  stopGraceSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  /** Sweep is cleanup/broadcast only; lazy expiration still gates claims/actions. */
  async sweepGrace(): Promise<number> {
    const now = this.deps.now();
    const matchIds = await findExpiredOperatorGraceMatches(now);
    let swept = 0;

    for (const matchId of matchIds) {
      const expired = await expireOperatorGraceIfNeeded(matchId, now);

      if (expired) {
        swept += 1;
        this.broadcastOperatorState(matchId, { active: false });
      }
    }

    return swept;
  }

  private attach(clientRef: ClientRef, input: Omit<SocketContext, 'clientRef'>): void {
    // Clear any previous role room for this match (e.g. viewer → operator on
    // handover) before joining the new role.
    this.deps.gateway.leave(input.matchId, clientRef);
    this.deps.gateway.join(input.matchId, clientRef, input.role);
    this.contexts.set(clientRef, { clientRef, ...input });

    if (input.role === 'operator') {
      this.broadcastOperatorState(input.matchId, {
        active: true,
        actorRef: input.sessionId,
      });
    }
  }

  private broadcastOperatorState(
    matchId: string,
    input: { active: boolean; actorRef?: string; graceUntil?: Date },
  ): void {
    this.deps.gateway.broadcastOperatorState(matchId, toOperatorStatePayload(input));
  }
}
