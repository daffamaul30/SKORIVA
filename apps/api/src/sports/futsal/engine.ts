/**
 * Futsal engine (T-21, Tech Spec §4.7).
 *
 * - Goal +1.
 * - Yellow/red cards are total counters with no automatic consequence (D-09).
 * - Clock may be `timed` (with optional stop) or `none`.
 * - `period.prev` is marker-only with guard (B-01); no rollback.
 * - No timeout (B-03).
 */

import type {
  FinalScoreCorrection,
  MatchAction,
  MatchConfig,
  MatchState,
  ResultCorrection,
  SportState,
  TeamSide,
} from '@skoriva/shared';
import { validateSportConfig } from '../shared/config-validation.js';
import { FUTSAL_DEFAULTS } from '../shared/constants.js';
import type { CorrectionResult, SportDisplay, SportEngineRuntime } from '../shared/types.js';
import { reduceFail, validationFail, validationOk } from '../shared/types.js';
import { initFutsalState } from './state.js';
import type { FutsalState } from './state.js';

function asState(state: SportState): FutsalState {
  return state as unknown as FutsalState;
}

function isSide(value: unknown): value is TeamSide {
  return value === 'home' || value === 'away';
}

function validateAction(
  action: MatchAction,
  config: MatchConfig,
): ReturnType<typeof validationOk> | ReturnType<typeof validationFail> {
  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side?: unknown; points?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Goal side must be home or away.');
      }
      if (payload.points !== 1) {
        return validationFail('INVALID_POINTS', 'Futsal goals are worth exactly 1 point.');
      }
      return validationOk();
    }

    case 'card.add': {
      const payload = action.payload as { side?: unknown; card?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Card side must be home or away.');
      }
      if (payload.card !== 'yellow' && payload.card !== 'red') {
        return validationFail('INVALID_CARD', 'Card must be yellow or red.');
      }
      return validationOk();
    }

    case 'period.next':
    case 'period.prev':
      return validationOk();

    case 'clock.start':
    case 'clock.pause':
    case 'clock.resume':
    case 'clock.reset':
    case 'clock.confirm':
      return config.gameClock.mode === 'timed'
        ? validationOk()
        : validationFail('CLOCK_MODE_NONE', 'This futsal match has no timed clock.');

    default:
      return validationFail(
        'ACTION_NOT_SUPPORTED',
        `Action ${action.type} is not supported by the futsal engine.`,
      );
  }
}

function reduceAction(
  state: FutsalState,
  action: MatchAction,
): { state: FutsalState; emitted: MatchAction['type'][] } | { error: string; message: string } {
  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side: TeamSide; points: number };

      return {
        state: {
          ...state,
          score: { ...state.score, [payload.side]: state.score[payload.side] + payload.points },
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['score.change'],
      };
    }

    case 'card.add': {
      const payload = action.payload as { side: TeamSide; card: 'yellow' | 'red' };
      const sideCards = state.cards[payload.side];

      return {
        state: {
          ...state,
          cards: {
            ...state.cards,
            [payload.side]: {
              ...sideCards,
              [payload.card]: sideCards[payload.card] + 1,
            },
          },
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['card.add'],
      };
    }

    case 'period.next':
    case 'period.prev':
      return {
        state: { ...state, periodActionCount: 0 },
        emitted: [action.type],
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

export function deriveFutsalDisplay(state: FutsalState): SportDisplay {
  return { score: state.score };
}

function correct(
  state: MatchState,
  correction: ResultCorrection,
  _config: MatchConfig,
): CorrectionResult {
  const value = correction as FinalScoreCorrection;

  if (
    typeof value.homeScore !== 'number' ||
    typeof value.awayScore !== 'number' ||
    !Number.isInteger(value.homeScore) ||
    !Number.isInteger(value.awayScore) ||
    value.homeScore < 0 ||
    value.awayScore < 0
  ) {
    return {
      ok: false,
      code: 'INVALID_CORRECTION',
      message: 'Futsal correction requires non-negative integer homeScore and awayScore.',
    };
  }

  const futsal = asState(state.sportState);
  const before = { score: futsal.score };
  const after = { score: { home: value.homeScore, away: value.awayScore } };

  return {
    ok: true,
    sportState: { ...futsal, score: after.score },
    before,
    after,
  };
}

export const futsalEngine: SportEngineRuntime = {
  sport: 'futsal',

  defaults: () => FUTSAL_DEFAULTS,

  init: (config) => initFutsalState(config),

  validateConfig: (config) => validateSportConfig('futsal', config),

  validate: (_state, action, context) => validateAction(action, context.config),

  reduce: (state, action) => {
    const result = reduceAction(asState(state), action);

    if ('error' in result) {
      return reduceFail(result.error, result.message);
    }

    return { ok: true, state: result.state, emitted: result.emitted };
  },

  deriveDisplay: (state) => deriveFutsalDisplay(asState(state)),

  suggestions: () => [
    { type: 'score.change', hint: 'Catat gol.' },
    { type: 'card.add', hint: 'Tambah kartu kuning/merah.' },
  ],

  canStepBackPeriod: (state) => asState(state.sportState).periodActionCount === 0,

  correct,
};
