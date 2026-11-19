/**
 * Sport reducer composition (T-19, wired into T-12).
 *
 * Routes clock actions to T-16, asks the sport engine to validate/reduce sport
 * actions, and applies core-owned period marker transitions. Engines only emit
 * `period.next` as an intent; they never mutate `state.period`.
 */

import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../models/index.js';
import type { DispatchAction, ReduceOutcome, StateReducer } from '../../core/match.service.js';
import { clockReducer } from '../../core/clock.js';
import type { SportRegistry } from '../registry.js';
import { advancePeriod, stepBackPeriod } from './period.js';
import type { SportReduceContext } from './types.js';

export type SportActionErrorCode =
  'ACTION_NOT_SUPPORTED' | 'PERIOD_PREV_BLOCKED' | 'SPORT_REDUCE_FAILED';

export class SportActionError extends Error {
  constructor(
    readonly code: SportActionErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = 'SportActionError';
  }
}

function isClockAction(type: string): boolean {
  return type.startsWith('clock.');
}

export function createSportReducer(registry: SportRegistry): StateReducer {
  return (state, action, match, now) => {
    const engine = registry.get(match.sport);

    if (isClockAction(action.type)) {
      const clockResult = clockReducer(match.config)(state, action, match, now);
      const clockContext: SportReduceContext = {
        clock: clockResult.state.clock,
        period: clockResult.state.period,
        config: match.config,
        now,
      };
      const sportResult = engine.reduce(clockResult.state.sportState, action, clockContext);

      if (!sportResult.ok) {
        throw new SportActionError(sportResult.code, sportResult.message);
      }

      return {
        state: { ...clockResult.state, sportState: sportResult.state },
        emitted: clockResult.emitted,
      };
    }

    const context: SportReduceContext = {
      clock: state.clock,
      period: state.period,
      config: match.config,
      now,
    };

    if (action.type === 'period.prev') {
      if (!engine.canStepBackPeriod(state)) {
        throw new SportActionError(
          'PERIOD_PREV_BLOCKED',
          'Cannot step back the period after a scoring or sport action. Use Undo instead.',
        );
      }

      const reduced = engine.reduce(state.sportState, action, context);
      if (!reduced.ok) {
        throw new SportActionError(reduced.code, reduced.message);
      }

      return {
        state: stepBackPeriod({ ...state, sportState: reduced.state }, match.config, now),
        emitted: ['period.prev'],
      };
    }

    const validation = engine.validate(state.sportState, action, context);
    if (!validation.ok) {
      throw new SportActionError(validation.code, validation.message);
    }

    const reduced = engine.reduce(state.sportState, action, context);
    if (!reduced.ok) {
      throw new SportActionError(reduced.code, reduced.message);
    }

    let nextState: MatchState = { ...state, sportState: reduced.state };
    const emitted = [...reduced.emitted];

    if (action.type === 'period.next' || emitted.includes('period.next')) {
      nextState = advancePeriod(nextState, match.config, now);
    }

    return { state: nextState, emitted };
  };
}

/** Convenience for application wiring. */
export function createSportReducerFor(
  registry: SportRegistry,
): (state: MatchState, action: DispatchAction, match: MatchDocument, now: Date) => ReduceOutcome {
  return createSportReducer(registry);
}
