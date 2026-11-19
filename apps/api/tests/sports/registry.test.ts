import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { MatchState, SportState } from '@skoriva/shared';
import { SportRegistry, SportRegistryError } from '../../src/sports/registry.js';
import type { SportEngineRuntime } from '../../src/sports/shared/types.js';
import { createSportReducer, SportActionError } from '../../src/sports/shared/reducer.js';
import { BASKETBALL_DEFAULTS } from '../../src/sports/shared/constants.js';
import type { DispatchAction } from '../../src/core/match.service.js';
import type { MatchDocument } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

function fakeEngine(overrides: Partial<SportEngineRuntime> = {}): SportEngineRuntime {
  return {
    sport: 'basketball',
    defaults: () => BASKETBALL_DEFAULTS,
    init: () => ({}),
    validateConfig: () => ({ ok: true }),
    validate: () => ({ ok: true }),
    reduce: (state, action) => ({ ok: true, state, emitted: [action.type] }),
    deriveDisplay: () => ({ score: { home: 0, away: 0 } }),
    suggestions: () => [],
    canStepBackPeriod: () => true,
    correct: () => ({ ok: false, code: 'NO', message: 'not implemented' }),
    ...overrides,
  };
}

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 600_000,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: 600_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: {},
    flags: { clockExpired: false, periodComplete: false },
    ...overrides,
  };
}

function match(overrides: Partial<MatchDocument> = {}): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    sport: 'basketball',
    config: BASKETBALL_DEFAULTS,
    ...overrides,
  } as MatchDocument;
}

function action(
  type: DispatchAction['type'],
  payload: Record<string, unknown> = {},
): DispatchAction {
  return { type, payload, txId: 'tx-1', expectedVersion: 0 } as DispatchAction;
}

describe('SportRegistry', () => {
  it('registers, selects, and lists engines', () => {
    const registry = new SportRegistry();
    const engine = fakeEngine();

    registry.register(engine);

    expect(registry.has('basketball')).toBe(true);
    expect(registry.get('basketball')).toBe(engine);
    expect(registry.list()).toEqual([engine]);
  });

  it('rejects duplicate registration and unknown sports', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());

    expect(() => registry.register(fakeEngine())).toThrow(SportRegistryError);
    expect(() => registry.get('volleyball')).toThrow(
      expect.objectContaining({ code: 'ENGINE_NOT_FOUND' }),
    );
  });
});

describe('createSportReducer', () => {
  it('routes clock actions to the core clock reducer', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const reducer = createSportReducer(registry);

    const result = reducer(state(), action('clock.start'), match(), T0);

    expect(result.state.clock.isRunning).toBe(true);
    expect(result.emitted).toEqual(['clock.start']);
  });

  it('routes sport actions to the selected engine', () => {
    const registry = new SportRegistry();
    registry.register(
      fakeEngine({
        reduce: (current, currentAction) => ({
          ok: true,
          state: {
            ...current,
            count: Number(current.count ?? 0) + 1,
            last: currentAction.type,
          },
          emitted: [currentAction.type],
        }),
      }),
    );
    const reducer = createSportReducer(registry);

    const result = reducer(state(), action('score.change'), match(), T0);

    expect(result.state.sportState).toMatchObject({ count: 1, last: 'score.change' });
  });

  it('advances the core period marker on period.next', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const reducer = createSportReducer(registry);

    const result = reducer(state(), action('period.next'), match(), T0);

    expect(result.state.period.index).toBe(1);
    expect(result.state.period.label).toBe('Q2');
    expect(result.state.clock.remainingMs).toBe(600_000);
  });

  it('advances the marker when the engine emits period.next', () => {
    const registry = new SportRegistry();
    registry.register(
      fakeEngine({
        reduce: (current, currentAction) => ({
          ok: true,
          state: current,
          emitted:
            currentAction.type === 'score.change'
              ? ['score.change', 'period.next']
              : [currentAction.type],
        }),
      }),
    );
    const reducer = createSportReducer(registry);

    const result = reducer(state(), action('score.change'), match(), T0);

    expect(result.state.period.index).toBe(1);
    expect(result.emitted).toEqual(['score.change', 'period.next']);
  });

  it('blocks period.prev when the engine guard rejects it', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine({ canStepBackPeriod: () => false }));
    const reducer = createSportReducer(registry);

    expect(() =>
      reducer(
        state({ period: { index: 1, label: 'Q2', status: 'active' } }),
        action('period.prev'),
        match(),
        T0,
      ),
    ).toThrow(expect.objectContaining({ code: 'PERIOD_PREV_BLOCKED' }));
  });

  it('steps the marker back without rolling back sport state', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const reducer = createSportReducer(registry);
    const sportState: SportState = { score: 10 };

    const result = reducer(
      state({ period: { index: 1, label: 'Q2', status: 'active' }, sportState }),
      action('period.prev'),
      match(),
      T0,
    );

    expect(result.state.period.index).toBe(0);
    expect(result.state.sportState).toEqual({ score: 10 });
  });

  it('surfaces engine validation failures as SportActionError', () => {
    const registry = new SportRegistry();
    registry.register(
      fakeEngine({
        validate: () => ({ ok: false, code: 'NOPE', message: 'not allowed' }),
      }),
    );
    const reducer = createSportReducer(registry);

    expect(() => reducer(state(), action('score.change'), match(), T0)).toThrow(SportActionError);
  });
});
