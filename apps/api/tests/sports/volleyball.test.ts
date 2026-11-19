import { describe, expect, it } from 'vitest';
import type { MatchAction, MatchState, TeamSide } from '@skoriva/shared';
import { volleyballEngine } from '../../src/sports/volleyball/index.js';
import type { VolleyballState } from '../../src/sports/volleyball/state.js';
import { VOLLEYBALL_DEFAULTS } from '../../src/sports/shared/constants.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { foldEvents } from '../../src/core/snapshot.js';
import type { ReplayableEvent } from '../../src/core/snapshot.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function baseSportState(overrides: Partial<VolleyballState> = {}): VolleyballState {
  return {
    ...(volleyballEngine.init(VOLLEYBALL_DEFAULTS) as unknown as VolleyballState),
    ...overrides,
  };
}

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
    period: { index: 0, label: 'Set 1', status: 'active' },
    clock: {
      mode: 'none',
      remainingMs: 0,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: 0,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: baseSportState(),
    flags: { clockExpired: false, periodComplete: false },
    ...overrides,
  };
}

function vstate(current: MatchState): VolleyballState {
  return current.sportState as unknown as VolleyballState;
}

function context(current = state(), now = T0) {
  return { clock: current.clock, period: current.period, config: VOLLEYBALL_DEFAULTS, now };
}

function action(type: MatchAction['type'], payload: Record<string, unknown> = {}): MatchAction {
  return { type, payload } as MatchAction;
}

function reduce(current: MatchState, currentAction: MatchAction): MatchState {
  const result = volleyballEngine.reduce(current.sportState, currentAction, context(current));
  if (!result.ok) throw new Error(result.code);
  return { ...current, sportState: result.state };
}

function point(current: MatchState, side: TeamSide, points = 1): MatchState {
  return reduce(current, action('score.change', { side, points }));
}

describe('volleyball engine', () => {
  it('adds a rally point', () => {
    const next = point(state(), 'home');
    expect(vstate(next).sets[0]).toMatchObject({ home: 1, away: 0 });
  });

  it('wins a normal set at 25 with a two-point lead and auto-advances', () => {
    const current = state({ sportState: baseSportState({ sets: [{ home: 24, away: 23 }] }) });
    const next = point(current, 'home');

    expect(vstate(next).sets[0]).toMatchObject({ home: 25, away: 23, winner: 'home' });
    expect(vstate(next).setsWon.home).toBe(1);
    expect(vstate(next).currentSet).toBe(1);
    expect(vstate(next).sets).toHaveLength(2);
  });

  it('continues at 24-24 until a two-point lead', () => {
    let current = state({ sportState: baseSportState({ sets: [{ home: 24, away: 24 }] }) });

    current = point(current, 'home');
    expect(vstate(current).sets[0]).toMatchObject({ home: 25, away: 24 });
    expect(vstate(current).sets[0]?.winner).toBeUndefined();

    current = point(current, 'home');
    expect(vstate(current).sets[0]).toMatchObject({ home: 26, away: 24, winner: 'home' });
  });

  it('uses the 15-point tiebreak in the deciding set and wins the match', () => {
    const current = state({
      sportState: baseSportState({
        sets: [
          { home: 25, away: 10, winner: 'home' },
          { home: 10, away: 25, winner: 'away' },
          { home: 14, away: 13 },
        ],
        currentSet: 2,
        setsWon: { home: 1, away: 1 },
      }),
    });

    const next = point(current, 'home');

    expect(vstate(next).sets[2]).toMatchObject({ home: 15, away: 13, winner: 'home' });
    expect(vstate(next).setsWon.home).toBe(2);
    expect(vstate(next).sets).toHaveLength(3);
  });

  it('supports best-of-five with a tiebreak in the fifth set', () => {
    const config = {
      ...VOLLEYBALL_DEFAULTS,
      periods: {
        count: 5,
        durationMs: 0,
        labels: ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'],
      },
      volleyball: { ...VOLLEYBALL_DEFAULTS.volleyball!, bestOf: 5 as const },
    };
    const current = state({
      sportState: baseSportState({
        sets: [
          { home: 25, away: 10, winner: 'home' },
          { home: 10, away: 25, winner: 'away' },
          { home: 25, away: 10, winner: 'home' },
          { home: 10, away: 25, winner: 'away' },
          { home: 14, away: 10 },
        ],
        currentSet: 4,
        setsWon: { home: 2, away: 2 },
      }),
    });

    const result = volleyballEngine.reduce(
      current.sportState,
      action('score.change', { side: 'home', points: 1 }),
      { ...context(current), config },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.state as unknown as VolleyballState).setsWon.home).toBe(3);
    }
  });

  it('allows a decrement only when it does not invalidate a completed set or go negative', () => {
    const current = state({ sportState: baseSportState({ sets: [{ home: 10, away: 8 }] }) });
    const next = point(current, 'home', -1);
    expect(vstate(next).sets[0]).toMatchObject({ home: 9, away: 8 });

    expect(
      volleyballEngine.validate(
        state({ sportState: baseSportState({ sets: [{ home: 0, away: 8 }] }) }).sportState,
        action('score.change', { side: 'home', points: -1 }),
        context(),
      ).ok,
    ).toBe(false);

    expect(
      volleyballEngine.validate(
        state({
          sportState: baseSportState({ sets: [{ home: 25, away: 10, winner: 'home' }] }),
        }).sportState,
        action('score.change', { side: 'home', points: -1 }),
        context(),
      ).ok,
    ).toBe(false);
  });

  it('rejects period.prev and no-clock actions', () => {
    const current = state();

    expect(
      volleyballEngine.validate(current.sportState, action('period.prev'), context(current)).ok,
    ).toBe(false);
    expect(
      volleyballEngine.validate(current.sportState, action('clock.start'), context(current)).ok,
    ).toBe(false);
  });

  it('only allows manual period.next when the current set is complete', () => {
    const incomplete = state();
    expect(
      volleyballEngine.validate(incomplete.sportState, action('period.next'), context(incomplete))
        .ok,
    ).toBe(false);

    const complete = state({
      sportState: baseSportState({
        sets: [{ home: 25, away: 10, winner: 'home' }],
        currentSet: 0,
      }),
    });
    const next = reduce(complete, action('period.next'));

    expect(vstate(next).currentSet).toBe(1);
    expect(vstate(next).sets).toHaveLength(2);

    expect(
      volleyballEngine.validate(next.sportState, action('period.next'), context(next)).ok,
    ).toBe(false);
  });

  it('rejects a timed volleyball config', () => {
    const timed = {
      ...VOLLEYBALL_DEFAULTS,
      gameClock: { mode: 'timed' as const, allowStop: true },
    };
    expect(volleyballEngine.validateConfig(timed).ok).toBe(false);
  });

  it('derives sets won plus the current set points', () => {
    const current = state({
      sportState: baseSportState({
        sets: [
          { home: 25, away: 10, winner: 'home' },
          { home: 5, away: 3 },
        ],
        currentSet: 1,
        setsWon: { home: 1, away: 0 },
      }),
    });

    const display = volleyballEngine.deriveDisplay(current.sportState);
    expect(display.score).toEqual({ home: 1, away: 0 });
    expect(display.sets).toHaveLength(2);
  });

  it('corrects sets and points and recomputes sets won', () => {
    const corrected = volleyballEngine.correct(
      state(),
      {
        sets: [
          { home: 25, away: 20, winner: 'home' },
          { home: 25, away: 22, winner: 'home' },
        ],
        points: { home: 25, away: 22 },
      },
      VOLLEYBALL_DEFAULTS,
    );

    expect(corrected.ok).toBe(true);
    if (corrected.ok) {
      expect((corrected.sportState as unknown as VolleyballState).setsWon).toEqual({
        home: 2,
        away: 0,
      });
    }
  });

  it('replays deterministically', () => {
    const registry = new SportRegistry();
    registry.register(volleyballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: VOLLEYBALL_DEFAULTS,
      sport: 'volleyball',
    });
    const events: ReplayableEvent[] = [
      { seq: 1, type: 'score.change', payload: { side: 'home', points: 1 }, serverTs: T0 },
      { seq: 2, type: 'score.change', payload: { side: 'home', points: 1 }, serverTs: at(1) },
      { seq: 3, type: 'score.change', payload: { side: 'away', points: 1 }, serverTs: at(2) },
    ];

    const first = foldEvents(state(), events, folder);
    const second = foldEvents(state(), events, folder);

    expect(first).toEqual(second);
    expect(vstate(first).sets[0]).toMatchObject({ home: 2, away: 1 });
  });
});
