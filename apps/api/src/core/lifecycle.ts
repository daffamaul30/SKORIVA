/**
 * Match lifecycle guard (T-13, PRD §3A / Tech Spec §1.4).
 *
 * Two independent axes:
 * 1. `matchStatus`: ready → live → finished; ready/live → cancelled (terminal).
 * 2. `resultDecision` (only meaningful while finished):
 *    undecided → saved (correct keeps saved);
 *    undecided → discarded → undecided (restore).
 *
 * The guard is pure and does not persist anything. T-29 maps the returned
 * transition to the REST response and T-14 records the lifecycle event.
 */

import type { MatchStatus, ResultDecision } from '@skoriva/shared';
import type { MatchDocument } from '../models/index.js';
import type { DispatchAction, LifecycleGuard } from './match.service.js';

export type LifecycleAction =
  'create' | 'start' | 'finish' | 'cancel' | 'reopen' | 'save' | 'discard' | 'restore' | 'correct';

export type LifecycleErrorCode =
  | 'INVALID_TRANSITION'
  | 'MATCH_CANCELLED'
  | 'RESULT_NOT_UNDECIDED'
  | 'SAVE_REQUIRES_RESTORE'
  | 'REOPEN_SAVED_USE_CORRECT'
  | 'CONFIG_LOCKED'
  | 'OPERATIONAL_NOT_ALLOWED';

export class LifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export interface LifecycleTransition {
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
}

function cancelled(): never {
  throw new LifecycleError('MATCH_CANCELLED', 'Match is cancelled and cannot change anymore.');
}

function invalid(action: LifecycleAction, match: MatchDocument): never {
  throw new LifecycleError(
    'INVALID_TRANSITION',
    `Cannot ${action} a match with status "${match.matchStatus}" and result "${match.resultDecision}".`,
  );
}

/**
 * Compute the target lifecycle state for an action, or throw a typed error.
 * `create` is handled separately because there is no previous match state.
 */
export function resolveLifecycleTransition(
  match: MatchDocument,
  action: LifecycleAction,
): LifecycleTransition {
  if (match.matchStatus === 'cancelled') cancelled();

  switch (action) {
    case 'start':
      if (match.matchStatus !== 'ready') invalid(action, match);
      return { matchStatus: 'live', resultDecision: 'undecided' };

    case 'finish':
      if (match.matchStatus !== 'live') invalid(action, match);
      return { matchStatus: 'finished', resultDecision: 'undecided' };

    case 'cancel':
      if (match.matchStatus !== 'ready' && match.matchStatus !== 'live') invalid(action, match);
      return { matchStatus: 'cancelled', resultDecision: match.resultDecision };

    case 'reopen':
      if (match.matchStatus !== 'finished') invalid(action, match);
      if (match.resultDecision === 'saved') {
        throw new LifecycleError(
          'REOPEN_SAVED_USE_CORRECT',
          'A saved result cannot be reopened; use the correction flow instead.',
        );
      }
      if (match.resultDecision === 'discarded') {
        throw new LifecycleError(
          'RESULT_NOT_UNDECIDED',
          'A discarded result cannot be reopened; restore it first.',
        );
      }
      return { matchStatus: 'live', resultDecision: 'undecided' };

    case 'save':
      if (match.matchStatus !== 'finished') invalid(action, match);
      if (match.resultDecision === 'discarded') {
        throw new LifecycleError(
          'SAVE_REQUIRES_RESTORE',
          'A discarded result must be restored before it can be saved.',
        );
      }
      if (match.resultDecision !== 'undecided') {
        throw new LifecycleError('RESULT_NOT_UNDECIDED', 'Only an undecided result can be saved.');
      }
      return { matchStatus: 'finished', resultDecision: 'saved' };

    case 'discard':
      if (match.matchStatus !== 'finished') invalid(action, match);
      if (match.resultDecision !== 'undecided') {
        throw new LifecycleError(
          'RESULT_NOT_UNDECIDED',
          'Only an undecided result can be discarded.',
        );
      }
      return { matchStatus: 'finished', resultDecision: 'discarded' };

    case 'restore':
      if (match.matchStatus !== 'finished') invalid(action, match);
      if (match.resultDecision !== 'discarded') {
        throw new LifecycleError('INVALID_TRANSITION', 'Only a discarded result can be restored.');
      }
      return { matchStatus: 'finished', resultDecision: 'undecided' };

    case 'correct':
      if (match.matchStatus !== 'finished') invalid(action, match);
      if (match.resultDecision !== 'saved') {
        throw new LifecycleError('INVALID_TRANSITION', 'Only a saved result can be corrected.');
      }
      return { matchStatus: 'finished', resultDecision: 'saved' };

    case 'create':
      return { matchStatus: 'ready', resultDecision: 'undecided' };
  }
}

export function canApplyLifecycleAction(match: MatchDocument, action: LifecycleAction): boolean {
  try {
    resolveLifecycleTransition(match, action);
    return true;
  } catch {
    return false;
  }
}

export function assertLifecycleAction(
  match: MatchDocument,
  action: LifecycleAction,
): LifecycleTransition {
  return resolveLifecycleTransition(match, action);
}

/** Config and teams may only change while the match is still ready (LC-02). */
export function assertConfigMutable(match: MatchDocument): void {
  if (match.matchStatus !== 'ready') {
    throw new LifecycleError(
      'CONFIG_LOCKED',
      'Teams and configuration can only be changed while the match is ready.',
    );
  }
}

/**
 * Operational actions (scores, clocks, periods, sport actions) are only valid
 * on a live match. Undo is the only action allowed on a finished, undecided
 * match; the undo implementation itself belongs to T-18.
 */
export function assertOperationalActionAllowed(match: MatchDocument, action: DispatchAction): void {
  if (match.matchStatus === 'cancelled') cancelled();

  if (match.matchStatus === 'live') return;

  if (match.matchStatus === 'finished' && match.resultDecision === 'undecided') {
    if (action.type === 'match.undo') return;
  }

  throw new LifecycleError(
    'OPERATIONAL_NOT_ALLOWED',
    `Action "${action.type}" is not allowed while the match is ${match.matchStatus}.`,
  );
}

/** T-12 `LifecycleGuard` implementation. */
export const lifecycleGuard: LifecycleGuard = {
  assertActionAllowed(match, action): void {
    assertOperationalActionAllowed(match, action);
  },
};
