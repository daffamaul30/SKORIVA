import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../src/models/index.js';
import type { MatchRuntime } from '../../src/core/runtime.registry.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';
import { MatchTicker } from '../../src/realtime/ticker.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

class FakeGateway implements RealtimeGateway {
  clocks: Array<{ matchId: string; payload: unknown }> = [];
  join(): void {}
  leave(): void {}
  disconnectRole(): void {}
  broadcastPatch(): void {}
  broadcastClock(matchId: string, payload: unknown): void {
    this.clocks.push({ matchId, payload });
  }
  broadcastStatus(): void {}
  broadcastOperatorState(): void {}
  emitTo(): void {}
}

function runtime(overrides: Partial<MatchRuntime> = {}): MatchRuntime {
  const state: MatchState = {
    version: 1,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 600_000,
      isRunning: true,
      anchorServerTs: T0.getTime(),
      lastDurableRemainingMs: 600_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: basketballEngine.init(BASKETBALL_DEFAULTS),
    flags: { clockExpired: false, periodComplete: false },
  };

  return {
    matchId: 'm1',
    match: {
      _id: new Types.ObjectId(),
      sport: 'basketball',
      matchStatus: 'live',
    } as MatchDocument,
    state,
    events: [],
    maxSeq: 1,
    lastStateAffectingSeq: 1,
    lastAccessAt: T0,
    ...overrides,
  };
}

function tickerFor(runtimes: MatchRuntime[], gateway: FakeGateway, onExpired = vi.fn()) {
  return {
    ticker: new MatchTicker({
      registry: { listRuntimes: () => runtimes },
      gateway,
      now: () => T0,
      onShotClockExpired: onExpired,
    }),
    onExpired,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MatchTicker', () => {
  it('broadcasts a derived clock for a live timed match', () => {
    const gateway = new FakeGateway();
    const { ticker } = tickerFor([runtime()], gateway);

    ticker.tick(at(10));

    expect(gateway.clocks).toHaveLength(1);
    expect(gateway.clocks[0]?.payload).toMatchObject({
      matchId: 'm1',
      clock: { remainingMs: 590_000, isRunning: true, expired: false },
      serverTs: at(10).toISOString(),
    });
  });

  it('does not broadcast for ready, finished, or mode none', () => {
    const gateway = new FakeGateway();
    const ready = runtime({
      match: {
        _id: new Types.ObjectId(),
        sport: 'basketball',
        matchStatus: 'ready',
      } as MatchDocument,
    });
    const finished = runtime({
      match: {
        _id: new Types.ObjectId(),
        sport: 'basketball',
        matchStatus: 'finished',
      } as MatchDocument,
    });
    const none = runtime({
      state: {
        ...runtime().state,
        clock: { ...runtime().state.clock, mode: 'none' },
      },
    });
    const { ticker } = tickerFor([ready, finished, none], gateway);

    ticker.tick(at(1));

    expect(gateway.clocks).toHaveLength(0);
  });

  it('triggers shot clock expiry once and includes the sport clock', () => {
    const gateway = new FakeGateway();
    const base = runtime();
    const basketball = base.state.sportState as unknown as {
      shotClock: Record<string, unknown>;
    };
    const expiredRuntime = runtime({
      state: {
        ...base.state,
        sportState: {
          ...basketball,
          shotClock: {
            ...basketball.shotClock,
            remainingMs: 1_000,
            running: true,
            anchorServerTs: T0.getTime(),
            expired: false,
          },
        },
      },
    });
    const { ticker, onExpired } = tickerFor([expiredRuntime], gateway);

    ticker.tick(at(1));
    ticker.tick(at(2));

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith('m1');
    expect(gateway.clocks[0]?.payload).toMatchObject({
      sportClock: { remainingMs: 0, running: true, expired: true },
    });
  });

  it('bounds retries when the expiry callback fails', async () => {
    const gateway = new FakeGateway();
    const base = runtime();
    const basketball = base.state.sportState as unknown as {
      shotClock: Record<string, unknown>;
    };
    const expiredRuntime = runtime({
      state: {
        ...base.state,
        sportState: {
          ...basketball,
          shotClock: {
            ...basketball.shotClock,
            remainingMs: 1_000,
            running: true,
            anchorServerTs: T0.getTime(),
            expired: false,
          },
        },
      },
    });
    const onExpired = vi.fn().mockRejectedValue(new Error('persist failed'));
    const { ticker } = tickerFor([expiredRuntime], gateway, onExpired);

    for (let index = 1; index <= 5; index += 1) {
      ticker.tick(at(index));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(onExpired).toHaveBeenCalledTimes(3);
  });

  it('stops the interval on stop()', () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const { ticker } = tickerFor([runtime()], gateway);

    ticker.start();
    vi.advanceTimersByTime(1_000);
    expect(gateway.clocks).toHaveLength(1);

    ticker.stop();
    vi.advanceTimersByTime(2_000);
    expect(gateway.clocks).toHaveLength(1);
  });
});
