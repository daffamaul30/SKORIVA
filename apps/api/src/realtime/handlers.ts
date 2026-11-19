/**
 * Socket.IO operational handlers (T-28).
 *
 * All operational actions go through the realtime-configured `MatchService`
 * (same T-12 queue, sport reducer, event log, and lifecycle guard). Lifecycle
 * actions are rejected and directed to REST. Ack is sent after persistence;
 * broadcast failures never roll back a committed database change.
 */

import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { MatchDocument } from '../models/index.js';
import type { DispatchAction } from '../core/match.service.js';
import type { MatchService } from '../core/match.service.js';
import { matchQueue } from '../core/match-queue.js';
import { runtimeRegistry } from '../core/runtime.registry.js';
import { buildSingleEvent } from '../core/event-log.js';
import { persistEventsAndState } from '../repositories/match.repo.js';
import {
  acceptHandoverCode,
  createHandoverCode,
  OperatorSessionError,
  rotateOperatorControlToken,
} from '../access/operator-session.js';
import { rotateViewCode } from '../access/tokens.js';
import type { ClientRef, RealtimeGateway } from './gateway.js';
import type { RoomManager } from './rooms.js';
import { joinAndSync } from './resync.js';
import {
  toMatchErrorPayload,
  toOperatorPatch,
  toOperatorSnapshot,
  toViewerPatch,
} from './serializers.js';

const OPERATIONAL_ACTION_TYPES = [
  'score.change',
  'clock.start',
  'clock.pause',
  'clock.resume',
  'clock.reset',
  'clock.confirm',
  'period.next',
  'period.prev',
  'shotClock.reset',
  'possession.set',
  'foul.add',
  'card.add',
  'badminton.serve.change',
  'badminton.interval',
  'badminton.changeEnds',
  'match.undo',
] as const;

const LIFECYCLE_TYPES = new Set([
  'match.start',
  'match.finish',
  'match.cancel',
  'match.reopen',
  'result.save',
  'result.discard',
  'result.restore',
  'result.correct',
]);

const matchIdSchema = z.string().min(1).max(128);
const txIdSchema = z.string().min(1).max(128);

const joinSchema = z
  .object({
    matchId: matchIdSchema,
    token: z.string().min(1).max(128).optional(),
    viewCode: z.string().min(1).max(128).optional(),
    lastVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

const actionSchema = z
  .object({
    matchId: matchIdSchema,
    txId: txIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    type: z.enum(OPERATIONAL_ACTION_TYPES),
    payload: z.record(z.unknown()),
  })
  .strict();

const clockConfirmSchema = z
  .object({
    matchId: matchIdSchema,
    txId: txIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

const matchOnlySchema = z.object({ matchId: matchIdSchema }).strict();
const handoverAcceptSchema = z
  .object({ matchId: matchIdSchema, code: z.string().min(1).max(128) })
  .strict();
const pongSchema = z.object({ ts: z.number().optional() }).strict();

type Ack = ((response: unknown) => void) | undefined;

export interface RealtimeHandlerDeps {
  gateway: RealtimeGateway;
  rooms: RoomManager;
  matchService: MatchService;
  pepper: string;
  now: () => Date;
}

function safeEmit(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(
      '[realtime] emit failed',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

function parsePayload<S extends ZodTypeAny>(
  schema: S,
  payload: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; message: string } {
  const result = schema.safeParse(payload);

  if (!result.success) {
    return {
      ok: false,
      message: result.error.issues
        .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
        .join('; '),
    };
  }

  return { ok: true, data: result.data };
}

function sendError(
  gateway: RealtimeGateway,
  clientRef: ClientRef,
  code: string,
  message: string,
  extra?: { currentVersion?: number; snapshot?: ReturnType<typeof toOperatorSnapshot> },
): void {
  safeEmit(() =>
    gateway.emitTo(clientRef, 'match:error', toMatchErrorPayload({ code, message, ...extra })),
  );
}

function rejectAck(ack: Ack, code: string, message: string, currentVersion?: number): void {
  ack?.({
    error: {
      code,
      message,
      ...(currentVersion !== undefined ? { currentVersion } : {}),
    },
  });
}

async function currentMatch(matchId: string): Promise<MatchDocument | null> {
  const peeked = runtimeRegistry.peek(matchId);
  if (peeked) return peeked.match;

  const loaded = await runtimeRegistry.loadMatch(matchId);
  return loaded?.match ?? null;
}

function broadcastCommitted(
  gateway: RealtimeGateway,
  match: MatchDocument,
  now: Date,
  event?: { seq: number; type: string; payload: unknown },
): void {
  const matchId = match._id.toString();

  safeEmit(() => gateway.broadcastPatch(matchId, toOperatorPatch(match, now, event), 'operator'));
  safeEmit(() => gateway.broadcastPatch(matchId, toViewerPatch(match, now), 'viewer'));
}

async function dispatchAndAck(
  socket: Socket,
  deps: RealtimeHandlerDeps,
  matchId: string,
  action: DispatchAction,
  ack: Ack,
): Promise<void> {
  const context = deps.rooms.getContext(socket.id);

  if (!context || context.role !== 'operator' || context.matchId !== matchId) {
    sendError(deps.gateway, socket.id, 'FORBIDDEN', 'Only the active operator can send actions.');
    rejectAck(ack, 'FORBIDDEN', 'Only the active operator can send actions.');
    return;
  }

  const result = await deps.matchService.dispatch(matchId, action, {
    operatorCredential: context.operatorCredential,
    actor: { type: 'operator', id: context.sessionId ?? 'operator' },
    now: deps.now(),
  });

  if (result.status === 'committed') {
    const match = await currentMatch(matchId);
    const lastEvent = result.events[result.events.length - 1];

    if (match) {
      broadcastCommitted(
        deps.gateway,
        match,
        deps.now(),
        lastEvent
          ? { seq: lastEvent.seq, type: lastEvent.type, payload: lastEvent.payload }
          : undefined,
      );
    }

    ack?.({ version: result.version, txId: result.txId });
    return;
  }

  if (result.status === 'duplicate') {
    const match = await currentMatch(matchId);

    if (match) {
      deps.gateway.emitTo(socket.id, 'match:snapshot', toOperatorSnapshot(match, deps.now()));
    }

    ack?.({ version: result.version, txId: result.txId });
    return;
  }

  if (result.status === 'version_conflict') {
    const match = await currentMatch(matchId);
    const snapshot = match ? toOperatorSnapshot(match, deps.now()) : undefined;

    sendError(
      deps.gateway,
      socket.id,
      'VERSION_CONFLICT',
      'expectedVersion is stale; reload the match snapshot.',
      { currentVersion: result.version, ...(snapshot ? { snapshot } : {}) },
    );
    rejectAck(ack, 'VERSION_CONFLICT', 'expectedVersion is stale.', result.version);
    return;
  }

  const match = await currentMatch(matchId);
  if (match) broadcastCommitted(deps.gateway, match, deps.now());

  const code = result.status === 'state_conflict' ? 'STATE_CONFLICT' : 'STATE_UPDATE_FAILED';
  const snapshot = match ? toOperatorSnapshot(match, deps.now()) : undefined;

  sendError(
    deps.gateway,
    socket.id,
    code,
    'The match state was repaired; resync from the snapshot.',
    { currentVersion: result.version, ...(snapshot ? { snapshot } : {}) },
  );
  rejectAck(ack, code, 'The match state was repaired.', result.version);
}

async function handleJoin(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(joinSchema, payload);

  if (!parsed.ok) {
    sendError(deps.gateway, socket.id, 'VALIDATION_ERROR', parsed.message);
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const result = await joinAndSync(socket.id, parsed.data, {
    rooms: deps.rooms,
    gateway: deps.gateway,
    now: deps.now,
  });

  if (result.ok) {
    ack?.({ ok: true, role: result.role });
  } else {
    rejectAck(ack, result.code, result.message);
  }
}

async function handleAction(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    typeof (payload as { type?: unknown }).type === 'string' &&
    LIFECYCLE_TYPES.has((payload as { type: string }).type)
  ) {
    sendError(
      deps.gateway,
      socket.id,
      'LIFECYCLE_VIA_REST',
      'Lifecycle actions must use the REST API.',
    );
    rejectAck(ack, 'LIFECYCLE_VIA_REST', 'Lifecycle actions must use the REST API.');
    return;
  }

  const parsed = parsePayload(actionSchema, payload);

  if (!parsed.ok) {
    sendError(deps.gateway, socket.id, 'VALIDATION_ERROR', parsed.message);
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const action: DispatchAction = {
    type: parsed.data.type,
    payload: parsed.data.payload,
    txId: parsed.data.txId,
    expectedVersion: parsed.data.expectedVersion,
  } as DispatchAction;

  await dispatchAndAck(socket, deps, parsed.data.matchId, action, ack);
}

async function handleClockConfirm(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(clockConfirmSchema, payload);

  if (!parsed.ok) {
    sendError(deps.gateway, socket.id, 'VALIDATION_ERROR', parsed.message);
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const action: DispatchAction = {
    type: 'clock.confirm',
    payload: parsed.data.payload ?? {},
    txId: parsed.data.txId,
    expectedVersion: parsed.data.expectedVersion,
  } as DispatchAction;

  await dispatchAndAck(socket, deps, parsed.data.matchId, action, ack);
}

async function handleLeave(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(matchOnlySchema, payload);

  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  await deps.rooms.leave(socket.id, parsed.data.matchId);
  ack?.({ ok: true });
}

function operatorContext(socket: Socket, deps: RealtimeHandlerDeps, matchId: string) {
  const context = deps.rooms.getContext(socket.id);

  if (!context || context.role !== 'operator' || context.matchId !== matchId) {
    return null;
  }

  return context;
}

function handleOperatorError(
  socket: Socket,
  deps: RealtimeHandlerDeps,
  error: unknown,
  ack: Ack,
): void {
  if (error instanceof OperatorSessionError) {
    sendError(deps.gateway, socket.id, error.code, error.message);
    rejectAck(ack, error.code, error.message);
    return;
  }

  throw error;
}

async function handleHandoverCreate(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(matchOnlySchema, payload);
  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const context = operatorContext(socket, deps, parsed.data.matchId);
  if (!context?.operatorCredential) {
    sendError(
      deps.gateway,
      socket.id,
      'FORBIDDEN',
      'Only the active operator can create a handover code.',
    );
    rejectAck(ack, 'FORBIDDEN', 'Only the active operator can create a handover code.');
    return;
  }

  try {
    const issued = await matchQueue.run(parsed.data.matchId, () =>
      createHandoverCode(parsed.data.matchId, context.operatorCredential!, deps.pepper, deps.now()),
    );

    ack?.({ code: issued.code, expiresAt: issued.expiresAt.toISOString() });
  } catch (error) {
    handleOperatorError(socket, deps, error, ack);
  }
}

async function handleHandoverAccept(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(handoverAcceptSchema, payload);
  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const context = deps.rooms.getContext(socket.id);
  if (!context || context.matchId !== parsed.data.matchId) {
    sendError(
      deps.gateway,
      socket.id,
      'JOIN_REQUIRED',
      'Join the match before accepting a handover code.',
    );
    rejectAck(ack, 'JOIN_REQUIRED', 'Join the match before accepting a handover code.');
    return;
  }

  try {
    await matchQueue.run(parsed.data.matchId, async () => {
      const accepted = await acceptHandoverCode(
        parsed.data.matchId,
        parsed.data.code,
        deps.pepper,
        deps.now(),
      );

      deps.rooms.adoptOperator(socket.id, parsed.data.matchId, accepted);
      deps.rooms.evictOperators(parsed.data.matchId, accepted.sessionId);
    });

    const match = await currentMatch(parsed.data.matchId);
    if (match) {
      deps.gateway.emitTo(socket.id, 'match:snapshot', toOperatorSnapshot(match, deps.now()));
    }

    ack?.({ active: true });
  } catch (error) {
    handleOperatorError(socket, deps, error, ack);
  }
}

async function handleRotateToken(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(matchOnlySchema, payload);
  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const context = operatorContext(socket, deps, parsed.data.matchId);
  if (!context) {
    sendError(
      deps.gateway,
      socket.id,
      'FORBIDDEN',
      'Only the active operator can rotate the control token.',
    );
    rejectAck(ack, 'FORBIDDEN', 'Only the active operator can rotate the control token.');
    return;
  }

  try {
    const rotated = await matchQueue.run(parsed.data.matchId, () =>
      rotateOperatorControlToken(parsed.data.matchId, deps.pepper, deps.now()),
    );

    const match = await currentMatch(parsed.data.matchId);
    if (match) {
      deps.gateway.emitTo(socket.id, 'match:snapshot', toOperatorSnapshot(match, deps.now()));
    }

    ack?.({ controlToken: rotated.controlToken, issuedAt: rotated.issuedAt.toISOString() });
  } catch (error) {
    handleOperatorError(socket, deps, error, ack);
  }
}

async function handleRotateViewCode(
  socket: Socket,
  payload: unknown,
  deps: RealtimeHandlerDeps,
  ack: Ack,
): Promise<void> {
  const parsed = parsePayload(matchOnlySchema, payload);
  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const context = operatorContext(socket, deps, parsed.data.matchId);
  if (!context) {
    sendError(
      deps.gateway,
      socket.id,
      'FORBIDDEN',
      'Only the active operator can rotate the view code.',
    );
    rejectAck(ack, 'FORBIDDEN', 'Only the active operator can rotate the view code.');
    return;
  }

  const matchId = parsed.data.matchId;

  const rotated = await matchQueue.run(matchId, async () => {
    const result = await rotateViewCode(matchId, deps.pepper, deps.now());

    try {
      const loaded = await runtimeRegistry.loadMatch(matchId);

      if (loaded) {
        const now = deps.now();
        const event = buildSingleEvent({
          seq: loaded.lastSeq + 1,
          txId: `view-code-rotate-${randomUUID()}`,
          type: 'context.update',
          payload: { fields: ['viewCode'] },
          actor: { type: 'operator', id: context.sessionId ?? 'operator' },
          now,
        });
        const state = { ...loaded.match.state, version: event.seq };
        await persistEventsAndState({ matchId, events: [event], state });
      }
    } catch (error) {
      // Rotation is already committed; keep the operator usable and log the
      // missing audit without exposing the view code.
      console.error(
        '[realtime] view-code rotation audit failed',
        error instanceof Error ? error.message : 'unknown error',
      );
    }

    return result;
  });

  deps.rooms.evictViewers(matchId);

  const match = await currentMatch(matchId);
  if (match) {
    deps.gateway.emitTo(socket.id, 'match:snapshot', toOperatorSnapshot(match, deps.now()));
  }

  ack?.({ viewCode: rotated.viewCode, issuedAt: rotated.issuedAt.toISOString() });
}

function handlePong(socket: Socket, payload: unknown, deps: RealtimeHandlerDeps, ack: Ack): void {
  const parsed = parsePayload(pongSchema, payload);
  if (!parsed.ok) {
    rejectAck(ack, 'VALIDATION_ERROR', parsed.message);
    return;
  }

  const response = { ts: parsed.data.ts ?? deps.now().getTime() };
  safeEmit(() => deps.gateway.emitTo(socket.id, 'match:pong', response));
  ack?.(response);
}

export function registerRealtimeHandlers(io: Server, deps: RealtimeHandlerDeps): void {
  io.on('connection', (socket) => {
    const run = (task: () => Promise<void>): void => {
      void task().catch((error: unknown) => {
        console.error(
          '[realtime] handler failed',
          error instanceof Error ? error.message : 'unknown error',
        );
        sendError(deps.gateway, socket.id, 'INTERNAL_ERROR', 'Internal server error.');
      });
    };

    socket.on('match:join', (payload: unknown, ack?: Ack) => {
      run(() => handleJoin(socket, payload, deps, ack));
    });

    socket.on('match:action', (payload: unknown, ack?: Ack) => {
      run(() => handleAction(socket, payload, deps, ack));
    });

    socket.on('clock.confirm', (payload: unknown, ack?: Ack) => {
      run(() => handleClockConfirm(socket, payload, deps, ack));
    });

    socket.on('match:leave', (payload: unknown, ack?: Ack) => {
      run(() => handleLeave(socket, payload, deps, ack));
    });

    socket.on('operator:handover.create', (payload: unknown, ack?: Ack) => {
      run(() => handleHandoverCreate(socket, payload, deps, ack));
    });

    socket.on('operator:handover.accept', (payload: unknown, ack?: Ack) => {
      run(() => handleHandoverAccept(socket, payload, deps, ack));
    });

    socket.on('operator:rotate-token', (payload: unknown, ack?: Ack) => {
      run(() => handleRotateToken(socket, payload, deps, ack));
    });

    socket.on('operator:rotate-view-code', (payload: unknown, ack?: Ack) => {
      run(() => handleRotateViewCode(socket, payload, deps, ack));
    });

    socket.on('match:pong', (payload: unknown, ack?: Ack) => {
      run(async () => {
        handlePong(socket, payload, deps, ack);
      });
    });

    socket.on('disconnect', () => {
      void deps.rooms.disconnect(socket.id).catch(() => undefined);
    });
  });
}
