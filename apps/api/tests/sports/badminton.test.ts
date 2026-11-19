import { describe, expect, it } from 'vitest';
import type { MatchAction, MatchState, TeamSide } from '@skoriva/shared';
import { badmintonEngine } from '../../src/sports/badminton/index.js';
import { BADMINTON_RULES_BASELINE } from '../../src/sports/badminton/rules-baseline.js';
import type { BadmintonState } from '../../src/sports/badminton/state.js';
import { BADMINTON_DEFAULTS } from '../../src/sports/shared/constants.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { foldEvents } from '../../src/core/snapshot.js';
import type { ReplayableEvent } from '../../src/core/snapshot.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function baseSportState(overrides: Partial<BadmintonState> = {}): BadmintonState {
  return {
    ...(badmintonEngine.init(BADMINTON_DEFAULTS) as unknown as BadmintonState),
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

function bstate(current: MatchState): BadmintonState {
  return current.sportState as unknown as BadmintonState;
}

function context(current = state(), now = T0) {
  return { clock: current.clock, period: current.period, config: BADMINTON_DEFAULTS, now };
}

function action(type: MatchAction['type'], payload: Record<string, unknown> = {}): MatchAction {
  return { type, payload } as MatchAction;
}

function reduce(current: MatchState, currentAction: MatchAction): MatchState {
  const result = badmintonEngine.reduce(current.sportState, currentAction, context(current));
  if (!result.ok) throw new Error(result.code);
  return { ...current, sportState: result.state };
}

function selected(side: TeamSide = 'home'): MatchState {
  return reduce(state(), action('badminton.serve.change', { side }));
}

function point(current: MatchState, side: TeamSide): MatchState {
  return reduce(current, action('score.change', { side, points: 1 }));
}

describe('badminton engine', () => {
  it('requires an explicit initial server before the first rally', () => {
    const result = badmintonEngine.validate(
      state().sportState,
      action('score.change', { side: 'home', points: 1 }),
      context(),
    );

    expect(result).toMatchObject({ ok: false, code: 'SERVER_NOT_SELECTED' });
  });

  it('selects the initial server and service court explicitly', () => {
    const current = selected('home');

    expect(bstate(current).serverSelected).toBe(true);
    expect(bstate(current).servingSide).toBe('home');
    expect(bstate(current).serviceCourt).toBe('right');
  });

  it('moves the serve to the rally winner and updates court parity', () => {
    let current = selected('home');
    current = point(current, 'home');

    expect(bstate(current).servingSide).toBe('home');
    expect(bstate(current).serviceCourt).toBe('left');

    current = point(current, 'away');
    expect(bstate(current).servingSide).toBe('away');
    expect(bstate(current).serviceCourt).toBe('left');
  });

  it('wins a set at 21 with a two-point lead and auto-advances', () => {
    const current = state({
      sportState: baseSportState({
        sets: [{ home: 20, away: 19 }],
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    const next = point(current, 'home');

    expect(bstate(next).sets[0]).toMatchObject({ home: 21, away: 19, winner: 'home' });
    expect(bstate(next).setsWon.home).toBe(1);
    expect(bstate(next).currentSet).toBe(1);
    expect(bstate(next).sets).toHaveLength(2);
  });

  it('continues at 20-20 until a two-point lead', () => {
    let current = state({
      sportState: baseSportState({
        sets: [{ home: 20, away: 20 }],
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    current = point(current, 'home');
    expect(bstate(current).sets[0]).toMatchObject({ home: 21, away: 20 });
    expect(bstate(current).sets[0]?.winner).toBeUndefined();

    current = point(current, 'home');
    expect(bstate(current).sets[0]).toMatchObject({ home: 22, away: 20, winner: 'home' });
  });

  it('caps the set at 30', () => {
    const current = state({
      sportState: baseSportState({
        sets: [{ home: 29, away: 29 }],
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    const next = point(current, 'home');
    expect(bstate(next).sets[0]).toMatchObject({ home: 30, away: 29, winner: 'home' });
  });

  it('wins the match at two sets and does not create a third set', () => {
    const current = state({
      sportState: baseSportState({
        sets: [
          { home: 21, away: 10, winner: 'home' },
          { home: 20, away: 5 },
        ],
        currentSet: 1,
        setsWon: { home: 1, away: 0 },
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    const next = point(current, 'home');

    expect(bstate(next).setsWon.home).toBe(2);
    expect(bstate(next).sets).toHaveLength(2);
    expect(bstate(next).currentSet).toBe(1);
  });

  it('activates the interval at 11 and lets the operator end it', () => {
    let current = state({
      sportState: baseSportState({
        sets: [{ home: 10, away: 0 }],
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    current = point(current, 'home');
    expect(bstate(current).intervalActive).toBe(true);
    expect(bstate(current).intervalTaken).toBe(true);

    current = reduce(current, action('badminton.interval', { action: 'end' }));
    expect(bstate(current).intervalActive).toBe(false);
  });

  it('sets change-ends pending at the end of a set and clears it on confirmation', () => {
    let current = state({
      sportState: baseSportState({
        sets: [{ home: 20, away: 0 }],
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    current = point(current, 'home');
    expect(bstate(current).changeEndsPending).toBe(true);

    current = reduce(current, action('badminton.changeEnds'));
    expect(bstate(current).changeEndsPending).toBe(false);
  });

  it('sets change-ends pending at 11 in the deciding set', () => {
    const current = state({
      sportState: baseSportState({
        sets: [
          { home: 21, away: 10, winner: 'home' },
          { home: 10, away: 21, winner: 'away' },
          { home: 10, away: 0 },
        ],
        currentSet: 2,
        setsWon: { home: 1, away: 1 },
        servingSide: 'home',
        serverSelected: true,
      }),
    });

    const next = point(current, 'home');
    expect(bstate(next).changeEndsPending).toBe(true);
  });

  it('rejects decrement, period.prev, and clock actions', () => {
    const current = selected('home');

    expect(
      badmintonEngine.validate(
        current.sportState,
        action('score.change', { side: 'home', points: -1 }),
        context(current),
      ).ok,
    ).toBe(false);
    expect(
      badmintonEngine.validate(current.sportState, action('period.prev'), context(current)).ok,
    ).toBe(false);
    expect(
      badmintonEngine.validate(current.sportState, action('clock.start'), context(current)).ok,
    ).toBe(false);
  });

  it('exposes servingSide and serviceCourt in the display', () => {
    const current = selected('away');
    const display = badmintonEngine.deriveDisplay(current.sportState);

    expect(display.badmintonServe).toEqual({ servingSide: 'away', serviceCourt: 'right' });
    expect(display.sets).toHaveLength(1);
  });

  it('corrects sets and points and recomputes sets won', () => {
    const corrected = badmintonEngine.correct(
      state(),
      {
        sets: [
          { home: 21, away: 15, winner: 'home' },
          { home: 21, away: 18, winner: 'home' },
        ],
        points: { home: 21, away: 18 },
      },
      BADMINTON_DEFAULTS,
    );

    expect(corrected.ok).toBe(true);
    if (corrected.ok) {
      expect(corrected.after.score).toEqual({ home: 21, away: 18 });
      expect((corrected.sportState as unknown as BadmintonState).setsWon).toEqual({
        home: 2,
        away: 0,
      });
    }
  });

  it('records the BWF baseline as pending article verification', () => {
    expect(BADMINTON_RULES_BASELINE.implementationStatus).toBe('PENDING_ARTICLE_VERIFICATION');
    expect(BADMINTON_RULES_BASELINE.pendingVerification.length).toBeGreaterThan(0);
  });

  it('replays deterministically', () => {
    const registry = new SportRegistry();
    registry.register(badmintonEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BADMINTON_DEFAULTS,
      sport: 'badminton',
    });
    const events: ReplayableEvent[] = [
      { seq: 1, type: 'badminton.serve.change', payload: { side: 'home' }, serverTs: T0 },
      { seq: 2, type: 'score.change', payload: { side: 'home', points: 1 }, serverTs: at(1) },
      { seq: 3, type: 'score.change', payload: { side: 'away', points: 1 }, serverTs: at(2) },
    ];

    const first = foldEvents(state(), events, folder);
    const second = foldEvents(state(), events, folder);

    expect(first).toEqual(second);
    expect(bstate(first).sets[0]).toMatchObject({ home: 1, away: 1 });
    expect(bstate(first).servingSide).toBe('away');
  });
});
