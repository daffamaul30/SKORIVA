/**
 * Socket.IO client wrapper (T-31.5).
 *
 * Design rules:
 * - `autoConnect: false` and no connection at module import time;
 * - explicit `connect()` / `disconnect()` lifecycle;
 * - the URL comes from the validated public environment (`NEXT_PUBLIC_SOCKET_URL`);
 * - credentials travel only inside the `match:join` payload, never in the URL;
 * - acknowledgements are normalised to `AckResult` without dropping
 *   `currentVersion`/`snapshot`;
 * - no reducers, no clock interpolation, no credential storage (T-31.6/T-31.7).
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { readPublicSocketUrl } from '../env';
import type {
  ActionAckOk,
  ActionPayload,
  ClockConfirmPayload,
  HandoverAcceptAck,
  HandoverAcceptPayload,
  HandoverCreateAck,
  JoinAckOk,
  JoinPayload,
  LeaveAck,
  LeavePayload,
  MatchClockPayload,
  MatchErrorPayloadShape,
  MatchOnlyPayload,
  MatchPatch,
  MatchSnapshot,
  MatchStatusPayload,
  OperatorSessionPayload,
  OperatorStatePayload,
  PongAck,
  PongPayload,
  RealtimeRole,
  RotateTokenAck,
  RotateViewCodeAck,
} from './socket-contract';
import { SOCKET_EVENTS } from './socket-contract';
import { parseAck, SocketClientError } from './socket-errors';
import type { AckResult } from './socket-errors';

/** Minimal surface of a socket.io client used by this wrapper (test seam). */
export interface SocketLike {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler?: (...args: unknown[]) => void): void;
}

export type SocketFactory = (url: string, options: Record<string, unknown>) => SocketLike;

export interface ConnectionStatePayload {
  state: 'connected' | 'disconnected' | 'reconnecting';
  attempt?: number;
}

export interface SocketClientOptions {
  /** Defaults to the validated `NEXT_PUBLIC_SOCKET_URL`. */
  url?: string;
  /** Test seam; production uses `socket.io-client`'s `io`. */
  factory?: SocketFactory;
  /** Ack wait before rejecting with `ACK_TIMEOUT`. Default 10s. */
  ackTimeoutMs?: number;
  /** Reconnection attempts; the backend keeps a 30s operator grace window. */
  reconnectionAttempts?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECTION_ATTEMPTS = 10;

function defaultFactory(url: string, options: Record<string, unknown>): SocketLike {
  return io(url, options) as unknown as SocketLike;
}

export class SocketClient {
  private readonly socket: SocketLike;
  private readonly ackTimeoutMs: number;

  constructor(options: SocketClientOptions = {}) {
    const url = options.url ?? readPublicSocketUrl();
    const factory = options.factory ?? defaultFactory;

    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.socket = factory(url, {
      autoConnect: false,
      // Credentials live in the join payload; no cookies are needed here.
      withCredentials: false,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: options.reconnectionAttempts ?? DEFAULT_RECONNECTION_ATTEMPTS,
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  /* ------------------------- lifecycle listeners ------------------------- */

  onConnect(handler: () => void): () => void {
    return this.subscribe('connect', handler);
  }

  onDisconnect(handler: (reason: string) => void): () => void {
    return this.subscribe('disconnect', handler as (...args: unknown[]) => void);
  }

  onConnectError(handler: (error: Error) => void): () => void {
    return this.subscribe('connect_error', handler as (...args: unknown[]) => void);
  }

  /** Fired by socket.io when a reconnection attempt starts. */
  onReconnecting(handler: (attempt: number) => void): () => void {
    return this.subscribe('reconnect_attempt', handler as (...args: unknown[]) => void);
  }

  private subscribe(event: string, handler: (...args: unknown[]) => void): () => void {
    this.socket.on(event, handler);
    return () => this.socket.off(event, handler);
  }

  /* --------------------------- server events ----------------------------- */

  onSnapshot(handler: (payload: MatchSnapshot) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.snapshot, handler);
  }

  onPatch(handler: (payload: MatchPatch) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.patch, handler);
  }

  onClock(handler: (payload: MatchClockPayload) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.clock, handler);
  }

  onStatus(handler: (payload: MatchStatusPayload) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.status, handler);
  }

  onOperatorState(handler: (payload: OperatorStatePayload) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.operatorState, handler);
  }

  onOperatorSession(handler: (payload: OperatorSessionPayload) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.operatorSession, handler);
  }

  onMatchError(handler: (payload: MatchErrorPayloadShape) => void): () => void {
    return this.subscribeTyped(SOCKET_EVENTS.error, handler);
  }

  private subscribeTyped<T>(event: string, handler: (payload: T) => void): () => void {
    return this.subscribe(event, handler as (...args: unknown[]) => void);
  }

  /* ---------------------------- client emits ----------------------------- */

  /** Join as operator (`token`) or viewer (`viewCode`). */
  async join(payload: JoinPayload): Promise<AckResult<JoinAckOk>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.join, payload);

    return parseAck<JoinAckOk>(raw, (value) => value.ok === true && isRole(value.role));
  }

  /** Operational action; lifecycle actions are rejected by the backend. */
  async sendAction(payload: ActionPayload): Promise<AckResult<ActionAckOk>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.action, payload);

    return parseAck<ActionAckOk>(raw, isActionAck);
  }

  /** Clock recovery confirmation (B-11). */
  async confirmClock(payload: ClockConfirmPayload): Promise<AckResult<ActionAckOk>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.clockConfirm, payload);

    return parseAck<ActionAckOk>(raw, isActionAck);
  }

  async leave(payload: LeavePayload): Promise<AckResult<LeaveAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.leave, payload);

    return parseAck<LeaveAck>(raw, (value) => value.ok === true);
  }

  async createHandoverCode(payload: MatchOnlyPayload): Promise<AckResult<HandoverCreateAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.handoverCreate, payload);

    return parseAck<HandoverCreateAck>(
      raw,
      (value) => typeof value.code === 'string' && typeof value.expiresAt === 'string',
    );
  }

  async acceptHandoverCode(
    payload: HandoverAcceptPayload,
  ): Promise<AckResult<HandoverAcceptAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.handoverAccept, payload);

    return parseAck<HandoverAcceptAck>(raw, (value) => value.active === true);
  }

  /** Replaces the control token only; the session credential is untouched. */
  async rotateControlToken(payload: MatchOnlyPayload): Promise<AckResult<RotateTokenAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.rotateToken, payload);

    return parseAck<RotateTokenAck>(
      raw,
      (value) => typeof value.controlToken === 'string' && typeof value.issuedAt === 'string',
    );
  }

  /** Replaces the viewer code only. */
  async rotateViewCode(payload: MatchOnlyPayload): Promise<AckResult<RotateViewCodeAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.rotateViewCode, payload);

    return parseAck<RotateViewCodeAck>(
      raw,
      (value) => typeof value.viewCode === 'string' && typeof value.issuedAt === 'string',
    );
  }

  async ping(payload: PongPayload = {}): Promise<AckResult<PongAck>> {
    const raw = await this.emitWithAck(SOCKET_EVENTS.pong, payload);

    return parseAck<PongAck>(raw, (value) => typeof value.ts === 'number');
  }

  /**
   * Emit with an ack callback and a bounded wait. A timeout becomes a
   * `SocketClientError` so callers never hang on a lost acknowledgement.
   */
  private emitWithAck(event: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new SocketClientError({
            code: 'ACK_TIMEOUT',
            backendMessage: `No acknowledgement for ${event}.`,
          }),
        );
      }, this.ackTimeoutMs);

      const settle = (value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      try {
        this.socket.emit(event, payload, settle);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(
          new SocketClientError({
            code: 'SOCKET_EMIT_FAILED',
            cause: error,
          }),
        );
      }
    });
  }
}

function isRole(value: unknown): value is RealtimeRole {
  return value === 'operator' || value === 'viewer';
}

function isActionAck(value: Record<string, unknown>): boolean {
  return typeof value.version === 'number' && typeof value.txId === 'string';
}

/** Factory only: no module-level singleton, so importing never connects. */
export function createSocketClient(options: SocketClientOptions = {}): SocketClient {
  return new SocketClient(options);
}

/** Type re-export for consumers that hold a raw socket reference. */
export type { Socket };
