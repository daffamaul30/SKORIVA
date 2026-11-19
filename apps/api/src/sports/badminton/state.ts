/**
 * Badminton sport state (T-22).
 *
 * BWF full-rules baseline: R-05 (Laws of Badminton, 26 April 2025 V5.0).
 * Article-level details that cannot be verified from the official source are
 * marked pending in `rules-baseline.ts`; they are not claimed as compliant.
 */

import type { MatchConfig, TeamSide } from '@skoriva/shared';

export interface BadmintonSet {
  home: number;
  away: number;
  winner?: TeamSide;
}

export interface BadmintonState extends Record<string, unknown> {
  sets: BadmintonSet[];
  currentSet: number;
  setsWon: { home: number; away: number };
  /** `undefined` until the operator explicitly selects the initial server. */
  servingSide?: TeamSide;
  serviceCourt: 'right' | 'left';
  serverSelected: boolean;
  intervalActive: boolean;
  intervalTaken: boolean;
  changeEndsPending: boolean;
  changeEndsTaken: boolean;
  matchPoint?: TeamSide;
  periodActionCount: number;
}

export function initBadmintonState(_config: MatchConfig): BadmintonState {
  return {
    sets: [{ home: 0, away: 0 }],
    currentSet: 0,
    setsWon: { home: 0, away: 0 },
    servingSide: undefined,
    serviceCourt: 'right',
    serverSelected: false,
    intervalActive: false,
    intervalTaken: false,
    changeEndsPending: false,
    changeEndsTaken: false,
    periodActionCount: 0,
  };
}
