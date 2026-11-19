import { describe, expect, it } from 'vitest';
import type { MatchAction, MatchState } from '@skoriva/shared';
import { basketballEngine, expireShotClock } from '../../src/sports/basketball/index.js';
import type { BasketballState } from '../../src/sports/basketball/state.js';
import { BASKETBALL_DEFAULTS } from '../../src/sports/shared/constants.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { foldEvents } from '../../src/core/snapshot.js';
import type { ReplayableEvent } from '../../src/core/snapshot.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
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
    ...overrides,
  };
}

function context(current = state(), now = T0) {
  return {
    clock: current.clock,
    period: current.period,
    config: BASKETBALL_DEFAULTS,
    now,
  };
}

function bball(current: MatchState): BasketballState {
  return current.sportState as unknown as BasketballState;
}

function action(type: MatchAction['type'], payload: Record<string, unknown> = {}): MatchAction {
  return { type, payload } as MatchAction;
}

function reduce(current: MatchState, currentAction: MatchAction, now = T0) {
  const result = basketballEngine.reduce(current.sportState, currentAction, context(current, now));
  if (!result.ok) throw new Error(result.code);
  return { ...current, sportState: result.state };
}

describe('basketball engine', () => {
  it('adds +1/+2/+3 and resets the shot clock in the same action', () => {
    const next = reduce(state(), action('score.change', { side: 'home', points: 3 }));

    expect(next.sportState.score).toEqual({ home: 3, away: 0 });
    expect(bball(next).shotClock.remainingMs).toBe(24_000);
    expect(bball(next).shotClock.lastDurableRemainingMs).toBe(24_000);
    expect(next.sportState.periodActionCount).toBe(1);
  });

  it('rejects invalid point values', () => {
    for (const points of [0, 4, -1]) {
      const result = basketballEngine.validate(
        state().sportState,
        action('score.change', { side: 'home', points }),
        context(),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('counts fouls without any automatic consequence', () => {
    let current = state();
    current = reduce(current, action('foul.add', { side: 'home' }));
    current = reduce(current, action('foul.add', { side: 'home' }));

    expect(current.sportState.fouls).toEqual({ home: 2, away: 0 });
    expect(current.sportState.score).toEqual({ home: 0, away: 0 });
  });

  it('pauses the shot clock together with the game clock', () => {
    let current = state();
    current = reduce(current, action('clock.start'), T0);
    current = reduce(current, action('clock.pause'), at(10));

    expect(bball(current).shotClock.running).toBe(false);
    expect(bball(current).shotClock.remainingMs).toBe(14_000);
  });

  it('resets the shot clock manually', () => {
    const current = reduce(state(), action('shotClock.reset'));

    expect(bball(current).shotClock.remainingMs).toBe(24_000);
    expect(bball(current).shotClock.expired).toBe(false);
  });

  it('stops the game clock and flags expiry when the shot clock reaches zero', () => {
    let current = state();
    current = reduce(current, action('score.change', { side: 'home', points: 2 }), T0);
    const expired = expireShotClock(current, at(24));

    expect(bball(expired.state).shotClock.expired).toBe(true);
    expect(bball(expired.state).shotClock.running).toBe(false);
    expect(expired.state.clock.isRunning).toBe(false);
    expect(expired.state.flags.clockExpired).toBe(true);
    expect(expired.emitted).toContain('shotClock.expired');
    expect(expired.emitted).toContain('clock.pause');
  });

  it('does not expire before the shot clock reaches zero', () => {
    const current = state();
    expect(expireShotClock(current, at(1)).emitted).toEqual([]);
  });

  it('advances to Q2 and resets the shot clock on period.next', () => {
    const current = reduce(state(), action('period.next'));

    expect(current.sportState.periodActionCount).toBe(0);
    expect(bball(current).shotClock.remainingMs).toBe(24_000);
  });

  it('guards period.prev after a sport action without rolling back', () => {
    let current = state();
    current = reduce(current, action('score.change', { side: 'home', points: 2 }));
    current = reduce(current, action('foul.add', { side: 'away' }));

    expect(basketballEngine.canStepBackPeriod(current)).toBe(false);

    const stepped = reduce(current, action('period.prev'));
    expect(stepped.sportState.score).toEqual({ home: 2, away: 0 });
    expect(stepped.sportState.fouls).toEqual({ home: 0, away: 1 });
    expect(stepped.sportState.periodActionCount).toBe(0);
  });

  it('allows period.prev before any sport action', () => {
    expect(basketballEngine.canStepBackPeriod(state())).toBe(true);
  });

  it('rejects unsupported actions and timeout', () => {
    expect(
      basketballEngine.validate(
        state().sportState,
        action('card.add', { side: 'home', card: 'yellow' }),
        context(),
      ).ok,
    ).toBe(false);
    expect(
      basketballEngine.validate(
        state().sportState,
        action('timeout' as MatchAction['type']),
        context(),
      ).ok,
    ).toBe(false);
  });

  it('corrects the final score', () => {
    const corrected = basketballEngine.correct(
      state(),
      { homeScore: 99, awayScore: 98 },
      BASKETBALL_DEFAULTS,
    );

    expect(corrected.ok).toBe(true);
    if (corrected.ok) {
      expect(corrected.after.score).toEqual({ home: 99, away: 98 });
      expect((corrected.sportState as { score: unknown }).score).toEqual({ home: 99, away: 98 });
    }
  });

  it('rejects invalid corrections', () => {
    const corrected = basketballEngine.correct(
      state(),
      { homeScore: -1, awayScore: 10 },
      BASKETBALL_DEFAULTS,
    );
    expect(corrected.ok).toBe(false);
  });

  it('replays deterministically', () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const events: ReplayableEvent[] = [
      { seq: 1, type: 'score.change', payload: { side: 'home', points: 2 }, serverTs: T0 },
      { seq: 2, type: 'foul.add', payload: { side: 'away' }, serverTs: at(1) },
      { seq: 3, type: 'score.change', payload: { side: 'away', points: 3 }, serverTs: at(2) },
    ];

    const first = foldEvents(
      { ...state(), clock: { ...state().clock, isRunning: false } },
      events,
      folder,
    );
    const second = foldEvents(
      { ...state(), clock: { ...state().clock, isRunning: false } },
      events,
      folder,
    );

    expect(first).toEqual(second);
    expect(first.sportState.score).toEqual({ home: 2, away: 3 });
    expect(first.sportState.fouls).toEqual({ home: 0, away: 1 });
  });
});
