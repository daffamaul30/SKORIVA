import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { MatchAction, MatchState } from '@skoriva/shared';
import { futsalEngine } from '../../src/sports/futsal/index.js';
import type { FutsalState } from '../../src/sports/futsal/state.js';
import { FUTSAL_DEFAULTS } from '../../src/sports/shared/constants.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { composeScoreboardView } from '../../src/sports/shared/display.js';
import { foldEvents } from '../../src/core/snapshot.js';
import type { ReplayableEvent } from '../../src/core/snapshot.js';
import type { MatchDocument } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
    period: { index: 0, label: '1st Half', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 1_200_000,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: 1_200_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: futsalEngine.init(FUTSAL_DEFAULTS),
    flags: { clockExpired: false, periodComplete: false },
    ...overrides,
  };
}

function futsal(current: MatchState): FutsalState {
  return current.sportState as unknown as FutsalState;
}

function context(current = state(), now = T0) {
  return { clock: current.clock, period: current.period, config: FUTSAL_DEFAULTS, now };
}

function action(type: MatchAction['type'], payload: Record<string, unknown> = {}): MatchAction {
  return { type, payload } as MatchAction;
}

function reduce(current: MatchState, currentAction: MatchAction): MatchState {
  const result = futsalEngine.reduce(current.sportState, currentAction, context(current));
  if (!result.ok) throw new Error(result.code);
  return { ...current, sportState: result.state };
}

describe('futsal engine', () => {
  it('adds a goal and rejects non-goal point values', () => {
    const next = reduce(state(), action('score.change', { side: 'home', points: 1 }));
    expect(futsal(next).score).toEqual({ home: 1, away: 0 });

    expect(
      futsalEngine.validate(
        state().sportState,
        action('score.change', { side: 'home', points: 2 }),
        context(),
      ).ok,
    ).toBe(false);
  });

  it('counts yellow and red cards without changing the score', () => {
    let current = state();
    current = reduce(current, action('card.add', { side: 'home', card: 'yellow' }));
    current = reduce(current, action('card.add', { side: 'home', card: 'red' }));
    current = reduce(current, action('card.add', { side: 'away', card: 'yellow' }));

    expect(futsal(current).cards).toEqual({
      home: { yellow: 1, red: 1 },
      away: { yellow: 1, red: 0 },
    });
    expect(futsal(current).score).toEqual({ home: 0, away: 0 });
  });

  it('rejects invalid cards', () => {
    expect(
      futsalEngine.validate(
        state().sportState,
        action('card.add', { side: 'home', card: 'blue' }),
        context(),
      ).ok,
    ).toBe(false);
  });

  it('resets the period action counter on period changes', () => {
    let current = reduce(state(), action('score.change', { side: 'home', points: 1 }));
    expect(futsalEngine.canStepBackPeriod(current)).toBe(false);

    current = reduce(current, action('period.next'));
    expect(futsal(current).periodActionCount).toBe(0);
    expect(futsal(current).score).toEqual({ home: 1, away: 0 });
  });

  it('rejects clock actions when the clock mode is none', () => {
    const noneConfig = { ...FUTSAL_DEFAULTS, gameClock: { mode: 'none' as const } };
    const result = futsalEngine.validate(state().sportState, action('clock.start'), {
      ...context(),
      config: noneConfig,
    });

    expect(result.ok).toBe(false);
  });

  it('omits the clock from the viewer display when mode is none', () => {
    const match = {
      _id: new Types.ObjectId(),
      sport: 'futsal',
      teams: {
        home: { name: 'Garuda', abbr: 'GRD', color: '#f00' },
        away: { name: 'Rajawali', abbr: 'RWJ', color: '#00f' },
      },
      config: { ...FUTSAL_DEFAULTS, gameClock: { mode: 'none' as const } },
      matchStatus: 'live',
      resultDecision: 'undecided',
      state: state({ clock: { ...state().clock, mode: 'none', remainingMs: 0 } }),
    } as unknown as MatchDocument;

    const view = composeScoreboardView(match, futsalEngine.deriveDisplay(match.state.sportState));
    expect(view.clock).toBeUndefined();
    expect(view.score).toEqual({ home: 0, away: 0 });
  });

  it('corrects the final score', () => {
    const corrected = futsalEngine.correct(
      state(),
      { homeScore: 4, awayScore: 3 },
      FUTSAL_DEFAULTS,
    );

    expect(corrected.ok).toBe(true);
    if (corrected.ok) {
      expect(corrected.after.score).toEqual({ home: 4, away: 3 });
    }
  });

  it('replays deterministically', () => {
    const registry = new SportRegistry();
    registry.register(futsalEngine);
    const folder = createSportReplayFolder({
      registry,
      config: FUTSAL_DEFAULTS,
      sport: 'futsal',
    });
    const events: ReplayableEvent[] = [
      { seq: 1, type: 'score.change', payload: { side: 'home', points: 1 }, serverTs: T0 },
      { seq: 2, type: 'card.add', payload: { side: 'away', card: 'yellow' }, serverTs: at(1) },
      { seq: 3, type: 'score.change', payload: { side: 'away', points: 1 }, serverTs: at(2) },
    ];

    const first = foldEvents(state(), events, folder);
    const second = foldEvents(state(), events, folder);

    expect(first).toEqual(second);
    expect(futsal(first).score).toEqual({ home: 1, away: 1 });
    expect(futsal(first).cards.away.yellow).toBe(1);
  });
});
