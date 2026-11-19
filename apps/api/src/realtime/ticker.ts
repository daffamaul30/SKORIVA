/**
 * Server-authoritative 1 Hz clock ticker (T-26, Tech Spec §4.2).
 *
 * Normal ticks only read the in-memory runtime and broadcast derived values;
 * they never touch MongoDB. Shot-clock expiry is a one-time transition handled
 * by the injected callback through the shared match queue.
 */

import type { MatchRuntime } from '../core/runtime.registry.js';
import { deriveRemainingMs } from '../core/clock.js';
import { deriveShotClockRemainingMs, isShotClockExpired } from '../sports/basketball/engine.js';
import type { BasketballState } from '../sports/basketball/state.js';
import type { RealtimeGateway } from './gateway.js';

export const DEFAULT_TICK_INTERVAL_MS = 1_000;
export const MAX_EXPIRY_ATTEMPTS = 3;

export interface TickerDeps {
  registry: { listRuntimes(): MatchRuntime[] };
  gateway: RealtimeGateway;
  intervalMs?: number;
  now?: () => Date;
  /** One-time shot-clock expiry transition; must be idempotent. */
  onShotClockExpired?: (matchId: string) => Promise<void> | void;
}

interface SportClockPayload {
  remainingMs: number;
  running: boolean;
  expired: boolean;
}

export class MatchTicker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly triggered = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: TickerDeps) {}

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick();
    }, this.deps.intervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One tick; public for deterministic tests. */
  tick(now = this.deps.now?.() ?? new Date()): void {
    for (const runtime of this.deps.registry.listRuntimes()) {
      if (runtime.match.matchStatus !== 'live' || runtime.state.clock.mode !== 'timed') {
        continue;
      }

      const remainingMs = deriveRemainingMs(runtime.state.clock, now);
      const sportClock = this.sportClock(runtime, now);

      this.deps.gateway.broadcastClock(runtime.matchId, {
        matchId: runtime.matchId,
        clock: {
          remainingMs,
          isRunning: runtime.state.clock.isRunning,
          expired: remainingMs === 0,
        },
        ...(sportClock ? { sportClock } : {}),
        serverTs: now.toISOString(),
      });

      if (!sportClock || !sportClock.expired) {
        this.triggered.delete(runtime.matchId);
        this.attempts.delete(runtime.matchId);
        continue;
      }

      if (this.triggered.has(runtime.matchId)) continue;

      this.triggered.add(runtime.matchId);
      const attempt = (this.attempts.get(runtime.matchId) ?? 0) + 1;
      this.attempts.set(runtime.matchId, attempt);

      void Promise.resolve(this.deps.onShotClockExpired?.(runtime.matchId)).catch(
        (error: unknown) => {
          console.error(
            '[realtime] shot clock expiry failed',
            error instanceof Error ? error.message : 'unknown error',
          );

          // Bounded retry: allow a few attempts, then wait for a reset/action.
          if (attempt < MAX_EXPIRY_ATTEMPTS) {
            this.triggered.delete(runtime.matchId);
          }
        },
      );
    }
  }

  private sportClock(runtime: MatchRuntime, now: Date): SportClockPayload | undefined {
    if (runtime.match.sport !== 'basketball') return undefined;

    const basketball = runtime.state.sportState as unknown as BasketballState;
    if (!basketball?.shotClock) return undefined;

    return {
      remainingMs: deriveShotClockRemainingMs(basketball.shotClock, now),
      running: basketball.shotClock.running,
      expired: isShotClockExpired(basketball.shotClock, now),
    };
  }
}
