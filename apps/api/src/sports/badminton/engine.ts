/**
 * Badminton engine (T-22, BWF full-rules baseline R-05).
 *
 * Implemented from the explicit PRD/Tech Spec rules:
 * - best of 3; set to 21, win by 2, cap 30;
 * - auto-advance set and emit `period.next`;
 * - service side/court, interval at 11, change ends at set end and at 11 in the
 *   deciding set;
 * - no `period.prev`, no direct decrement (FIX 4 Option A).
 *
 * The initial server is selected explicitly by the operator before the first
 * rally. There is no default home server and no coin-toss simulation.
 *
 * Article-level BWF details that require the official PDF are marked pending in
 * `rules-baseline.ts`; this engine does not claim full BWF compliance yet.
 */

import type {
  BadmintonConfig,
  MatchAction,
  MatchConfig,
  MatchState,
  ResultCorrection,
  SetsAndPointsCorrection,
  SportState,
  TeamSide,
} from '@skoriva/shared';
import { validateSportConfig } from '../shared/config-validation.js';
import { BADMINTON_DEFAULTS } from '../shared/constants.js';
import type {
  CorrectionResult,
  SportDisplay,
  SportEngineRuntime,
  SportReduceContext,
} from '../shared/types.js';
import { reduceFail, validationFail, validationOk } from '../shared/types.js';
import { initBadmintonState } from './state.js';
import type { BadmintonSet, BadmintonState } from './state.js';

function asState(state: SportState): BadmintonState {
  return state as unknown as BadmintonState;
}

function isSide(value: unknown): value is TeamSide {
  return value === 'home' || value === 'away';
}

function rulesOf(config: MatchConfig): BadmintonConfig {
  if (!config.badminton) {
    throw new Error('Badminton config is required.');
  }
  return config.badminton;
}

function setWinner(set: BadmintonSet, rules: BadmintonConfig): TeamSide | null {
  if (set.home >= rules.pointCap) return 'home';
  if (set.away >= rules.pointCap) return 'away';
  if (set.home >= rules.pointTarget && set.home - set.away >= rules.winByDiff) return 'home';
  if (set.away >= rules.pointTarget && set.away - set.home >= rules.winByDiff) return 'away';
  return null;
}

function matchWon(setsWon: { home: number; away: number }): boolean {
  return setsWon.home >= 2 || setsWon.away >= 2;
}

function serviceCourtFor(score: number): 'right' | 'left' {
  return score % 2 === 0 ? 'right' : 'left';
}

function validateAction(
  state: BadmintonState,
  action: MatchAction,
  _config: MatchConfig,
): ReturnType<typeof validationOk> | ReturnType<typeof validationFail> {
  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side?: unknown; points?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Point side must be home or away.');
      }
      if (payload.points !== 1) {
        return validationFail(
          'INVALID_POINTS',
          'Badminton rally points are +1 only; use Undo to correct a point.',
        );
      }
      if (!state.serverSelected) {
        return validationFail(
          'SERVER_NOT_SELECTED',
          'Select the initial server before recording the first rally.',
        );
      }
      if (matchWon(state.setsWon)) {
        return validationFail('MATCH_ALREADY_WON', 'The match has already been won.');
      }
      return validationOk();
    }

    case 'badminton.serve.change': {
      const payload = action.payload as { side?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Server side must be home or away.');
      }
      return validationOk();
    }

    case 'badminton.interval': {
      const payload = action.payload as { action?: unknown };
      if (payload.action !== 'start' && payload.action !== 'end') {
        return validationFail('INVALID_INTERVAL', 'Interval action must be start or end.');
      }
      if (payload.action === 'start' && state.intervalActive) {
        return validationFail('INTERVAL_ALREADY_ACTIVE', 'Interval is already active.');
      }
      if (payload.action === 'end' && !state.intervalActive) {
        return validationFail('INTERVAL_NOT_ACTIVE', 'Interval is not active.');
      }
      return validationOk();
    }

    case 'badminton.changeEnds':
      if (!state.changeEndsPending) {
        return validationFail('CHANGE_ENDS_NOT_PENDING', 'Change ends is not pending.');
      }
      return validationOk();

    case 'period.next':
    case 'period.prev':
      return validationFail(
        'AUTO_ADVANCE_ONLY',
        'Badminton sets advance automatically; use Undo to correct a set.',
      );

    case 'clock.start':
    case 'clock.pause':
    case 'clock.resume':
    case 'clock.reset':
    case 'clock.confirm':
      return validationFail('CLOCK_MODE_NONE', 'Badminton has no game clock.');

    default:
      return validationFail(
        'ACTION_NOT_SUPPORTED',
        `Action ${action.type} is not supported by the badminton engine.`,
      );
  }
}

function reduceAction(
  state: BadmintonState,
  action: MatchAction,
  context: SportReduceContext,
): { state: BadmintonState; emitted: MatchAction['type'][] } | { error: string; message: string } {
  const rules = rulesOf(context.config);

  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side: TeamSide; points: number };
      const side = payload.side;
      const current = state.sets[state.currentSet] ?? { home: 0, away: 0 };
      const nextSet: BadmintonSet = {
        ...current,
        [side]: current[side] + payload.points,
      };
      const servingSide = side;
      const serviceCourt = serviceCourtFor(nextSet[side]);
      const winner = setWinner(nextSet, rules);

      if (winner) {
        const sets = [...state.sets];
        sets[state.currentSet] = { ...nextSet, winner };
        const setsWon = {
          ...state.setsWon,
          [winner]: state.setsWon[winner] + 1,
        };

        if (matchWon(setsWon)) {
          return {
            state: {
              ...state,
              sets,
              setsWon,
              servingSide,
              serviceCourt,
              intervalActive: false,
              changeEndsPending: false,
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
            servingSide: winner,
            serviceCourt: 'right',
            intervalActive: false,
            intervalTaken: false,
            changeEndsPending: true,
            changeEndsTaken: false,
            periodActionCount: state.periodActionCount + 1,
          },
          emitted: ['score.change', 'period.next'],
        };
      }

      let intervalActive = state.intervalActive;
      let intervalTaken = state.intervalTaken;

      if (
        !intervalTaken &&
        (nextSet.home === rules.intervalAt || nextSet.away === rules.intervalAt)
      ) {
        intervalActive = true;
        intervalTaken = true;
      }

      let changeEndsPending = state.changeEndsPending;
      let changeEndsTaken = state.changeEndsTaken;

      if (
        state.currentSet === 2 &&
        !changeEndsTaken &&
        (nextSet.home === rules.changeEndsAtDecidingSet ||
          nextSet.away === rules.changeEndsAtDecidingSet)
      ) {
        changeEndsPending = true;
        changeEndsTaken = true;
      }

      const sets = [...state.sets];
      sets[state.currentSet] = nextSet;

      return {
        state: {
          ...state,
          sets,
          servingSide,
          serviceCourt,
          intervalActive,
          intervalTaken,
          changeEndsPending,
          changeEndsTaken,
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['score.change'],
      };
    }

    case 'badminton.serve.change': {
      const payload = action.payload as { side: TeamSide };
      const current = state.sets[state.currentSet] ?? { home: 0, away: 0 };

      return {
        state: {
          ...state,
          servingSide: payload.side,
          serverSelected: true,
          serviceCourt: serviceCourtFor(current[payload.side]),
        },
        emitted: ['badminton.serve.change'],
      };
    }

    case 'badminton.interval': {
      const payload = action.payload as { action: 'start' | 'end' };

      return {
        state: { ...state, intervalActive: payload.action === 'start' },
        emitted: ['badminton.interval'],
      };
    }

    case 'badminton.changeEnds':
      return {
        state: { ...state, changeEndsPending: false },
        emitted: ['badminton.changeEnds'],
      };

    case 'period.next':
    case 'period.prev':
      return { error: 'AUTO_ADVANCE_ONLY', message: 'Badminton sets advance automatically.' };

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

export function deriveBadmintonDisplay(state: BadmintonState): SportDisplay {
  const current = state.sets[state.currentSet] ?? { home: 0, away: 0 };

  return {
    score: { home: current.home, away: current.away },
    sets: state.sets.map((set) => ({
      home: set.home,
      away: set.away,
      ...(set.winner ? { winner: set.winner } : {}),
    })),
    ...(state.serverSelected && state.servingSide
      ? {
          badmintonServe: {
            servingSide: state.servingSide,
            serviceCourt: state.serviceCourt,
          },
        }
      : {}),
    period: {
      index: state.currentSet,
      label: `Set ${state.currentSet + 1}`,
      total: 3,
    },
  };
}

function correct(
  state: MatchState,
  correction: ResultCorrection,
  config: MatchConfig,
): CorrectionResult {
  const value = correction as SetsAndPointsCorrection;
  const badminton = asState(state.sportState);
  const rules = rulesOf(config);

  if (!Array.isArray(value.sets) || value.sets.length === 0 || value.sets.length > 3) {
    return {
      ok: false,
      code: 'INVALID_CORRECTION',
      message: 'Badminton correction requires between 1 and 3 sets.',
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
      message: 'Badminton correction points must be non-negative integers.',
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
        message: 'Badminton correction set scores must be non-negative integers.',
      };
    }
  }

  const sets: BadmintonSet[] = value.sets.map((set) => ({
    home: set.home,
    away: set.away,
    ...(set.winner ? { winner: set.winner } : {}),
  }));

  const last = sets[sets.length - 1]!;
  sets[sets.length - 1] = { ...last, home: value.points.home, away: value.points.away };

  for (const set of sets) {
    if (!set.winner) {
      const winner = setWinner(set, rules);
      if (winner) set.winner = winner;
    }
  }

  const setsWon = { home: 0, away: 0 };
  for (const set of sets) {
    if (set.winner) setsWon[set.winner] += 1;
  }

  const before = deriveBadmintonDisplay(badminton);
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
      ...badminton,
      sets,
      currentSet: sets.length - 1,
      setsWon,
      intervalActive: false,
      changeEndsPending: false,
    },
    before: { score: before.score, sets: before.sets },
    after,
  };
}

export const badmintonEngine: SportEngineRuntime = {
  sport: 'badminton',

  defaults: () => BADMINTON_DEFAULTS,

  init: (config) => initBadmintonState(config),

  validateConfig: (config) => validateSportConfig('badminton', config),

  validate: (state, action, context) => validateAction(asState(state), action, context.config),

  reduce: (state, action, context) => {
    const result = reduceAction(asState(state), action, context);

    if ('error' in result) {
      return reduceFail(result.error, result.message);
    }

    return { ok: true, state: result.state, emitted: result.emitted };
  },

  deriveDisplay: (state) => deriveBadmintonDisplay(asState(state)),

  suggestions: () => [
    { type: 'badminton.serve.change', hint: 'Pilih server awal atau koreksi server.' },
    { type: 'score.change', hint: 'Tambah poin rally.' },
    { type: 'badminton.interval', hint: 'Mulai/akhiri interval.' },
    { type: 'badminton.changeEnds', hint: 'Konfirmasi pergantian sisi.' },
  ],

  canStepBackPeriod: () => false,

  correct,
};
