/**
 * Volleyball engine (T-23, Tech Spec §4.7).
 *
 * - Rally point +1; a decrement is allowed only when it does not invalidate a
 *   completed set and never produces a negative score (FR-06).
 * - Normal set to 25, tiebreak to 15, win by 2 (`winByDiff`), best of 3 or 5.
 * - Sets auto-advance; `period.prev` is rejected and points to Undo.
 * - No game clock (mode `timed` is rejected by config validation).
 * - No timeout (B-03).
 */

import type {
  MatchAction,
  MatchConfig,
  MatchState,
  ResultCorrection,
  SetsAndPointsCorrection,
  SportState,
  TeamSide,
  VolleyballConfig,
} from '@skoriva/shared';
import { validateSportConfig } from '../shared/config-validation.js';
import { VOLLEYBALL_DEFAULTS } from '../shared/constants.js';
import type {
  CorrectionResult,
  SportDisplay,
  SportEngineRuntime,
  SportReduceContext,
} from '../shared/types.js';
import { reduceFail, validationFail, validationOk } from '../shared/types.js';
import { initVolleyballState } from './state.js';
import type { VolleyballSet, VolleyballState } from './state.js';

function asState(state: SportState): VolleyballState {
  return state as unknown as VolleyballState;
}

function isSide(value: unknown): value is TeamSide {
  return value === 'home' || value === 'away';
}

function rulesOf(config: MatchConfig): VolleyballConfig {
  if (!config.volleyball) {
    throw new Error('Volleyball config is required.');
  }
  return config.volleyball;
}

function targetForSet(index: number, rules: VolleyballConfig): number {
  return index === rules.bestOf - 1 ? rules.tiebreakTarget : rules.pointTarget;
}

function setWinner(set: VolleyballSet, index: number, rules: VolleyballConfig): TeamSide | null {
  const target = targetForSet(index, rules);

  if (set.home >= target && set.home - set.away >= rules.winByDiff) return 'home';
  if (set.away >= target && set.away - set.home >= rules.winByDiff) return 'away';
  return null;
}

function matchWinner(
  setsWon: { home: number; away: number },
  rules: VolleyballConfig,
): TeamSide | null {
  const required = Math.ceil(rules.bestOf / 2);
  if (setsWon.home >= required) return 'home';
  if (setsWon.away >= required) return 'away';
  return null;
}

function validateAction(
  state: VolleyballState,
  action: MatchAction,
): ReturnType<typeof validationOk> | ReturnType<typeof validationFail> {
  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side?: unknown; points?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Point side must be home or away.');
      }
      if (payload.points !== 1 && payload.points !== -1) {
        return validationFail('INVALID_POINTS', 'Volleyball points must be +1 or -1.');
      }

      const current = state.sets[state.currentSet] ?? { home: 0, away: 0 };

      if (payload.points < 0) {
        if (current.winner) {
          return validationFail(
            'SET_ALREADY_WON',
            'A completed set cannot be reduced; use Undo to correct it.',
          );
        }
        if (current[payload.side] + payload.points < 0) {
          return validationFail('NEGATIVE_SCORE', 'A score cannot become negative.');
        }
      }

      return validationOk();
    }

    case 'period.next': {
      const current = state.sets[state.currentSet];
      if (!current?.winner) {
        return validationFail(
          'SET_NOT_COMPLETE',
          'Advance only after the current set is complete.',
        );
      }
      return validationOk();
    }

    case 'period.prev':
      return validationFail(
        'PERIOD_PREV_NOT_SUPPORTED',
        'Volleyball sets cannot step back; use Undo to correct a set.',
      );

    case 'clock.start':
    case 'clock.pause':
    case 'clock.resume':
    case 'clock.reset':
    case 'clock.confirm':
      return validationFail('CLOCK_MODE_NONE', 'Volleyball has no game clock.');

    default:
      return validationFail(
        'ACTION_NOT_SUPPORTED',
        `Action ${action.type} is not supported by the volleyball engine.`,
      );
  }
}

function reduceAction(
  state: VolleyballState,
  action: MatchAction,
  context: SportReduceContext,
): { state: VolleyballState; emitted: MatchAction['type'][] } | { error: string; message: string } {
  const rules = rulesOf(context.config);

  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side: TeamSide; points: number };
      const current = state.sets[state.currentSet] ?? { home: 0, away: 0 };
      const nextSet: VolleyballSet = {
        ...current,
        [payload.side]: current[payload.side] + payload.points,
      };

      if (payload.points < 0) {
        const sets = [...state.sets];
        sets[state.currentSet] = nextSet;

        return {
          state: { ...state, sets },
          emitted: ['score.change'],
        };
      }

      const winner = setWinner(nextSet, state.currentSet, rules);

      if (!winner) {
        const sets = [...state.sets];
        sets[state.currentSet] = nextSet;

        return {
          state: { ...state, sets, periodActionCount: state.periodActionCount + 1 },
          emitted: ['score.change'],
        };
      }

      const sets = [...state.sets];
      sets[state.currentSet] = { ...nextSet, winner };
      const setsWon = { ...state.setsWon, [winner]: state.setsWon[winner] + 1 };
      const won = matchWinner(setsWon, rules);

      if (won) {
        return {
          state: {
            ...state,
            sets,
            setsWon,
            periodActionCount: state.periodActionCount + 1,
          },
          emitted: ['score.change'],
        };
      }

      return {
        state: {
          ...state,
          sets: [...sets, { home: 0, away: 0 }],
          currentSet: state.currentSet + 1,
          setsWon,
          periodActionCount: 0,
        },
        emitted: ['score.change', 'period.next'],
      };
    }

    case 'period.next': {
      const current = state.sets[state.currentSet];

      if (!current?.winner) {
        return { error: 'SET_NOT_COMPLETE', message: 'Current set is not complete.' };
      }

      if (matchWinner(state.setsWon, rules)) {
        return { error: 'MATCH_ALREADY_WON', message: 'The match has already been won.' };
      }

      return {
        state: {
          ...state,
          sets: [...state.sets, { home: 0, away: 0 }],
          currentSet: state.currentSet + 1,
          periodActionCount: 0,
        },
        emitted: ['period.next'],
      };
    }

    case 'period.prev':
      return {
        error: 'PERIOD_PREV_NOT_SUPPORTED',
        message: 'Volleyball sets cannot step back.',
      };

    case 'clock.start':
    case 'clock.pause':
    case 'clock.resume':
    case 'clock.reset':
    case 'clock.confirm':
      return { state, emitted: [] };

    default:
      return { error: 'ACTION_NOT_SUPPORTED', message: `Unsupported action ${action.type}.` };
  }
}

export function deriveVolleyballDisplay(state: VolleyballState): SportDisplay {
  return {
    score: { home: state.setsWon.home, away: state.setsWon.away },
    sets: state.sets.map((set) => ({
      home: set.home,
      away: set.away,
      ...(set.winner ? { winner: set.winner } : {}),
    })),
    period: {
      index: state.currentSet,
      label: `Set ${state.currentSet + 1}`,
      total: state.sets.length,
    },
  };
}

function correct(
  state: MatchState,
  correction: ResultCorrection,
  config: MatchConfig,
): CorrectionResult {
  const value = correction as SetsAndPointsCorrection;
  const volleyball = asState(state.sportState);
  const rules = rulesOf(config);

  if (!Array.isArray(value.sets) || value.sets.length === 0 || value.sets.length > rules.bestOf) {
    return {
      ok: false,
      code: 'INVALID_CORRECTION',
      message: `Volleyball correction requires between 1 and ${rules.bestOf} sets.`,
    };
  }

  if (
    !value.points ||
    !Number.isInteger(value.points.home) ||
    !Number.isInteger(value.points.away) ||
    value.points.home < 0 ||
    value.points.away < 0
  ) {
    return {
      ok: false,
      code: 'INVALID_CORRECTION',
      message: 'Volleyball correction points must be non-negative integers.',
    };
  }

  for (const set of value.sets) {
    if (
      !Number.isInteger(set.home) ||
      !Number.isInteger(set.away) ||
      set.home < 0 ||
      set.away < 0
    ) {
      return {
        ok: false,
        code: 'INVALID_CORRECTION',
        message: 'Volleyball correction set scores must be non-negative integers.',
      };
    }
  }

  const sets: VolleyballSet[] = value.sets.map((set) => ({
    home: set.home,
    away: set.away,
    ...(set.winner ? { winner: set.winner } : {}),
  }));

  const last = sets[sets.length - 1]!;
  sets[sets.length - 1] = { ...last, home: value.points.home, away: value.points.away };

  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index]!;
    if (!set.winner) {
      const winner = setWinner(set, index, rules);
      if (winner) set.winner = winner;
    }
  }

  const setsWon = { home: 0, away: 0 };
  for (const set of sets) {
    if (set.winner) setsWon[set.winner] += 1;
  }

  const before = deriveVolleyballDisplay(volleyball);
  const after = {
    score: value.points,
    sets: sets.map((set) => ({
      home: set.home,
      away: set.away,
      ...(set.winner ? { winner: set.winner } : {}),
    })),
  };

  return {
    ok: true,
    sportState: {
      ...volleyball,
      sets,
      currentSet: sets.length - 1,
      setsWon,
    },
    before: { score: before.score, sets: before.sets },
    after,
  };
}

export const volleyballEngine: SportEngineRuntime = {
  sport: 'volleyball',

  defaults: () => VOLLEYBALL_DEFAULTS,

  init: (config) => initVolleyballState(config),

  validateConfig: (config) => validateSportConfig('volleyball', config),

  validate: (state, action) => validateAction(asState(state), action),

  reduce: (state, action, context) => {
    const result = reduceAction(asState(state), action, context);

    if ('error' in result) {
      return reduceFail(result.error, result.message);
    }

    return { ok: true, state: result.state, emitted: result.emitted };
  },

  deriveDisplay: (state) => deriveVolleyballDisplay(asState(state)),

  suggestions: () => [{ type: 'score.change', hint: 'Tambah poin rally (+1) atau koreksi (-1).' }],

  canStepBackPeriod: () => false,

  correct,
};
