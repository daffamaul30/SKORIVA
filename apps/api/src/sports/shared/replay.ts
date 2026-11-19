/**
 * Sport replay folder (T-19).
 *
 * Folds event rows into `MatchState` deterministically:
 * - clock events use T-16;
 * - period events apply the core marker transition and ask the engine to reset
 *   its period-scoped state;
 * - operational events call the sport engine reducer; emitted period intents
 *   are ignored because the explicit `period.next` event already owns the
 *   marker transition;
 * - `result.correct` re-runs `engine.correct()` and verifies the stored `after`;
 * - `match.undo` is skipped (T-18 filters its targets before folding).
 */

import type { MatchConfig, MatchAction, ResultCorrection, Sport } from '@skoriva/shared';
import type { EventFolder, ReplayableEvent } from '../../core/snapshot.js';
import { eventToAction } from '../../core/snapshot.js';
import { applyClockEvent } from '../../core/clock.js';
import type { SportRegistry } from '../registry.js';
import { advancePeriod, stepBackPeriod } from './period.js';
import type { CorrectionAudit, SportDomainEvent, SportReduceContext } from './types.js';

export class SportReplayError extends Error {
  constructor(
    readonly code: 'CORRECTION_REPLAY_MISMATCH' | 'SPORT_REPLAY_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SportReplayError';
  }
}

function auditEqual(left: CorrectionAudit, right: CorrectionAudit): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPeriodNext(event: ReplayableEvent): boolean {
  return event.type === 'period.next';
}

function isPeriodPrev(event: ReplayableEvent): boolean {
  return event.type === 'period.prev';
}

export interface SportReplayOptions {
  registry: SportRegistry;
  config: MatchConfig;
  sport: Sport;
}

/**
 * Build a replay folder for one match. `config` is required because period
 * transitions and correction replay need the match configuration.
 */
export function createSportReplayFolder(options: SportReplayOptions): EventFolder {
  const { registry, config, sport } = options;

  return (state, event) => {
    const engine = registry.get(sport);

    const context: SportReduceContext = {
      clock: state.clock,
      period: state.period,
      config,
      now: event.serverTs,
    };

    if (event.type.startsWith('clock.')) {
      return applyClockEvent(state, event, config);
    }

    if (event.type === 'match.undo') {
      // T-18's foldWithUndo removes the target action before folding.
      return state;
    }

    if (event.type === 'result.correct') {
      const payload = event.payload as {
        correction?: ResultCorrection;
        after?: CorrectionAudit;
      };

      if (!payload.correction) {
        throw new SportReplayError(
          'SPORT_REPLAY_FAILED',
          `result.correct at seq ${event.seq} is missing a correction payload.`,
        );
      }

      const corrected = engine.correct(state, payload.correction, config);

      if (!corrected.ok) {
        throw new SportReplayError(
          'SPORT_REPLAY_FAILED',
          `result.correct at seq ${event.seq} failed to replay: ${corrected.code}.`,
        );
      }

      if (payload.after && !auditEqual(corrected.after, payload.after)) {
        throw new SportReplayError(
          'CORRECTION_REPLAY_MISMATCH',
          `result.correct at seq ${event.seq} replayed to a different after value.`,
        );
      }

      return { ...state, sportState: corrected.sportState };
    }

    if (isPeriodPrev(event)) {
      const reduced = engine.reduce(
        state.sportState,
        {
          type: 'period.prev',
          payload: {},
        } as MatchAction,
        context,
      );

      const sportState = reduced.ok ? reduced.state : state.sportState;
      return stepBackPeriod({ ...state, sportState }, config, event.serverTs);
    }

    if (isPeriodNext(event)) {
      const reduced = engine.reduce(
        state.sportState,
        {
          type: 'period.next',
          payload: {},
        } as MatchAction,
        context,
      );

      const sportState = reduced.ok ? reduced.state : state.sportState;
      return advancePeriod({ ...state, sportState }, config, event.serverTs);
    }

    if (event.type === 'shotClock.expired' && engine.applyDomainEvent) {
      const domainEvent: SportDomainEvent = {
        type: event.type,
        payload: event.payload,
        serverTs: event.serverTs,
      };
      return engine.applyDomainEvent(state, domainEvent);
    }

    const action = eventToAction(event);
    if (!action) return state;

    const reduced = engine.reduce(state.sportState, action, context);

    if (!reduced.ok) {
      throw new SportReplayError(
        'SPORT_REPLAY_FAILED',
        `Event seq ${event.seq} (${event.type}) failed to replay: ${reduced.code}.`,
      );
    }

    return { ...state, sportState: reduced.state };
  };
}
