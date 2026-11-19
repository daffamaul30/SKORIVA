/**
 * Basketball engine (T-20, Tech Spec §4.7).
 *
 * - +1/+2/+3 scoring; a score resets the shot clock in the same action.
 * - Fouls are a total counter per team; no foul-out, bonus, or automatic effect.
 * - Shot clock 24s lives in `sportState`; it pauses with the game clock and
 *   expiry stops the game clock and waits for the operator.
 * - `period.prev` is marker-only with guard (B-01); no score/foul rollback.
 * - No timeout (B-03).
 */

import type {
  EventType,
  FinalScoreCorrection,
  MatchAction,
  MatchConfig,
  MatchState,
  ResultCorrection,
  SportState,
  TeamSide,
} from '@skoriva/shared';
import { stopClock } from '../../core/clock.js';
import { validateSportConfig } from '../shared/config-validation.js';
import { BASKETBALL_DEFAULTS } from '../shared/constants.js';
import type {
  CorrectionResult,
  SportDisplay,
  SportDomainEvent,
  SportEngineRuntime,
  SportReduceContext,
} from '../shared/types.js';
import { reduceFail, validationFail, validationOk } from '../shared/types.js';
import { initBasketballState } from './state.js';
import type { BasketballShotClockState, BasketballState } from './state.js';

function asState(state: SportState): BasketballState {
  return state as unknown as BasketballState;
}

function isSide(value: unknown): value is TeamSide {
  return value === 'home' || value === 'away';
}

export function deriveShotClockRemainingMs(shotClock: BasketballShotClockState, now: Date): number {
  if (!shotClock.running) return Math.max(0, shotClock.remainingMs);

  const elapsed = now.getTime() - shotClock.anchorServerTs;
  return Math.max(0, shotClock.remainingMs - Math.max(0, elapsed));
}

export function isShotClockExpired(shotClock: BasketballShotClockState, now: Date): boolean {
  return shotClock.running && deriveShotClockRemainingMs(shotClock, now) === 0;
}

function resetShotClock(
  _shotClock: BasketballShotClockState,
  durationMs: number,
  running: boolean,
  now: Date,
): BasketballShotClockState {
  return {
    remainingMs: durationMs,
    running,
    anchorServerTs: running ? now.getTime() : 0,
    lastDurableRemainingMs: durationMs,
    lastDurableAt: now.toISOString(),
    expired: false,
  };
}

function checkpointShotClock(
  shotClock: BasketballShotClockState,
  now: Date,
): BasketballShotClockState {
  return {
    ...shotClock,
    lastDurableRemainingMs: deriveShotClockRemainingMs(shotClock, now),
    lastDurableAt: now.toISOString(),
  };
}

function validateAction(
  _state: BasketballState,
  action: MatchAction,
  config: MatchConfig,
): ReturnType<typeof validationOk> | ReturnType<typeof validationFail> {
  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side?: unknown; points?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Score side must be home or away.');
      }
      if (
        typeof payload.points !== 'number' ||
        !config.scoring.pointsPerGoal.includes(payload.points)
      ) {
        return validationFail(
          'INVALID_POINTS',
          `Basketball points must be one of ${config.scoring.pointsPerGoal.join(', ')}.`,
        );
      }
      return validationOk();
    }

    case 'foul.add': {
      const payload = action.payload as { side?: unknown };
      if (!isSide(payload.side)) {
        return validationFail('INVALID_SIDE', 'Foul side must be home or away.');
      }
      return validationOk();
    }

    case 'shotClock.reset':
      if (!config.shotClock.enabled) {
        return validationFail('SHOT_CLOCK_DISABLED', 'Shot clock is not enabled.');
      }
      return validationOk();

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
        : validationFail('CLOCK_MODE_NONE', 'Basketball requires a timed clock.');

    default:
      return validationFail(
        'ACTION_NOT_SUPPORTED',
        `Action ${action.type} is not supported by the basketball engine.`,
      );
  }
}

function reduceAction(
  state: BasketballState,
  action: MatchAction,
  context: SportReduceContext,
): { state: BasketballState; emitted: MatchAction['type'][] } | { error: string; message: string } {
  const config = context.config;

  switch (action.type) {
    case 'score.change': {
      const payload = action.payload as { side: TeamSide; points: number };
      const durationMs = config.shotClock.enabled ? config.shotClock.durationMs : 0;

      return {
        state: {
          ...state,
          score: { ...state.score, [payload.side]: state.score[payload.side] + payload.points },
          shotClock: resetShotClock(
            state.shotClock,
            durationMs,
            context.clock.isRunning,
            context.now,
          ),
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['score.change'],
      };
    }

    case 'foul.add': {
      const payload = action.payload as { side: TeamSide };

      return {
        state: {
          ...state,
          fouls: { ...state.fouls, [payload.side]: state.fouls[payload.side] + 1 },
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['foul.add'],
      };
    }

    case 'shotClock.reset': {
      const durationMs = config.shotClock.enabled ? config.shotClock.durationMs : 0;

      return {
        state: {
          ...state,
          shotClock: resetShotClock(
            state.shotClock,
            durationMs,
            context.clock.isRunning,
            context.now,
          ),
          periodActionCount: state.periodActionCount + 1,
        },
        emitted: ['shotClock.reset'],
      };
    }

    case 'period.next': {
      const durationMs = config.shotClock.enabled ? config.shotClock.durationMs : 0;

      return {
        state: {
          ...state,
          shotClock: resetShotClock(state.shotClock, durationMs, false, context.now),
          periodActionCount: 0,
        },
        emitted: ['period.next'],
      };
    }

    case 'period.prev':
      return {
        state: {
          ...state,
          shotClock: checkpointShotClock(
            { ...state.shotClock, running: false, anchorServerTs: 0 },
            context.now,
          ),
          periodActionCount: 0,
        },
        emitted: ['period.prev'],
      };

    case 'clock.pause':
      return {
        state: {
          ...state,
          shotClock: checkpointShotClock(
            {
              ...state.shotClock,
              remainingMs: deriveShotClockRemainingMs(state.shotClock, context.now),
              running: false,
              anchorServerTs: 0,
            },
            context.now,
          ),
        },
        emitted: [],
      };

    case 'clock.resume':
    case 'clock.start':
      return {
        state: {
          ...state,
          shotClock: {
            ...state.shotClock,
            running: true,
            anchorServerTs: context.now.getTime(),
          },
        },
        emitted: [],
      };

    case 'clock.reset':
      return {
        state: {
          ...state,
          shotClock: resetShotClock(
            state.shotClock,
            config.shotClock.enabled ? config.shotClock.durationMs : 0,
            false,
            context.now,
          ),
        },
        emitted: [],
      };

    case 'clock.confirm':
      return { state, emitted: [] };

    default:
      return { error: 'ACTION_NOT_SUPPORTED', message: `Unsupported action ${action.type}.` };
  }
}

export function deriveBasketballDisplay(state: BasketballState, now = new Date()): SportDisplay {
  return {
    score: state.score,
    shotClock: {
      remainingMs: deriveShotClockRemainingMs(state.shotClock, now),
      running: state.shotClock.running,
      expired: state.shotClock.expired,
    },
  };
}

/**
 * Shot-clock expiry helper for the T-26 ticker. Stops the game clock and marks
 * the shot clock expired; the operator decides the next action.
 */
export function expireShotClock(
  state: MatchState,
  now = new Date(),
): { state: MatchState; emitted: EventType[] } {
  const basketball = asState(state.sportState);

  if (!isShotClockExpired(basketball.shotClock, now)) {
    return { state, emitted: [] };
  }

  return {
    state: {
      ...state,
      clock: stopClock(state.clock, now),
      sportState: {
        ...basketball,
        shotClock: {
          ...basketball.shotClock,
          remainingMs: 0,
          running: false,
          anchorServerTs: 0,
          lastDurableRemainingMs: 0,
          lastDurableAt: now.toISOString(),
          expired: true,
        },
      },
      flags: { ...state.flags, clockExpired: true },
    },
    emitted: ['shotClock.expired', 'clock.pause'],
  };
}

function applyDomainEvent(state: MatchState, event: SportDomainEvent): MatchState {
  if (event.type !== 'shotClock.expired') return state;

  const basketball = asState(state.sportState);

  return {
    ...state,
    clock: stopClock(state.clock, event.serverTs),
    sportState: {
      ...basketball,
      shotClock: {
        ...basketball.shotClock,
        remainingMs: 0,
        running: false,
        anchorServerTs: 0,
        lastDurableRemainingMs: 0,
        lastDurableAt: event.serverTs.toISOString(),
        expired: true,
      },
    },
    flags: { ...state.flags, clockExpired: true },
  };
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
      message: 'Basketball correction requires non-negative integer homeScore and awayScore.',
    };
  }

  const basketball = asState(state.sportState);
  const before = { score: basketball.score };
  const after = { score: { home: value.homeScore, away: value.awayScore } };

  return {
    ok: true,
    sportState: { ...basketball, score: after.score },
    before,
    after,
  };
}

export const basketballEngine: SportEngineRuntime = {
  sport: 'basketball',

  defaults: () => BASKETBALL_DEFAULTS,

  init: (config) => initBasketballState(config),

  validateConfig: (config) => validateSportConfig('basketball', config),

  validate: (state, action, context) => validateAction(asState(state), action, context.config),

  reduce: (state, action, context) => {
    const result = reduceAction(asState(state), action, context);

    if ('error' in result) {
      return reduceFail(result.error, result.message);
    }

    return { ok: true, state: result.state, emitted: result.emitted };
  },

  deriveDisplay: (state, now) => deriveBasketballDisplay(asState(state), now),

  suggestions: () => [
    { type: 'score.change', hint: 'Catat poin (1/2/3).' },
    { type: 'foul.add', hint: 'Tambah foul tim.' },
    { type: 'shotClock.reset', hint: 'Reset shot clock.' },
  ],

  canStepBackPeriod: (state) => asState(state.sportState).periodActionCount === 0,

  correct,

  applyDomainEvent,
};
