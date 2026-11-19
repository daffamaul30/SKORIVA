/**
 * Deterministic fake socket for T-31.5 tests.
 *
 * Records client emits, lets the test push server events and acknowledgements.
 * No timers, no network — so lifecycle and ack assertions stay stable.
 */

import type { SocketLike } from '@/lib/realtime/socket-client';

type Handler = (...args: unknown[]) => void;

export interface SentEmit {
  event: string;
  payload: unknown;
  hasAck: boolean;
}

export class FakeSocket implements SocketLike {
  connected = false;
  readonly sent: SentEmit[] = [];
  readonly options: Record<string, unknown>;
  readonly url: string;
  /** Number of `on()` registrations per event, to detect duplicate listeners. */
  readonly registrations = new Map<string, number>();

  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly pendingAcks: Array<(response: unknown) => void> = [];

  constructor(url = 'http://localhost:4000', options: Record<string, unknown> = {}) {
    this.url = url;
    this.options = options;
  }

  connect(): void {
    this.connected = true;
    this.dispatch('connect');
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dispatch('disconnect', 'io client disconnect');
  }

  emit(event: string, ...args: unknown[]): unknown {
    const ack = args.find((arg): arg is (response: unknown) => void => typeof arg === 'function');
    const payload = args.find((arg) => typeof arg !== 'function');

    this.sent.push({ event, payload, hasAck: ack !== undefined });

    if (ack) {
      this.pendingAcks.push(ack);
    }

    return this;
  }

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    this.registrations.set(event, (this.registrations.get(event) ?? 0) + 1);
  }

  off(event: string, handler?: Handler): void {
    if (!handler) {
      this.handlers.delete(event);
      return;
    }
    this.handlers.get(event)?.delete(handler);
  }

  /** Simulate a server → client event. */
  serverEmit(event: string, payload: unknown): void {
    this.dispatch(event, payload);
  }

  /** Simulate a server connection error. */
  failConnection(message = 'connection refused'): void {
    this.dispatch('connect_error', new Error(message));
  }

  /** Simulate the start of a reconnection attempt. */
  beginReconnect(attempt: number): void {
    this.dispatch('reconnect_attempt', attempt);
  }

  /** Resolve the oldest pending ack. */
  respondAck(response: unknown): void {
    const ack = this.pendingAcks.shift();
    if (!ack) throw new Error('no pending ack to resolve');
    ack(response);
  }

  lastEmit(): SentEmit {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error('no emit recorded');
    return last;
  }

  private dispatch(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}
