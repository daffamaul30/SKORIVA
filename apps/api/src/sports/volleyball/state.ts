/**
 * Volleyball sport state (T-23).
 *
 * Rally points, sets, and the derived display. No game clock is ever present.
 */

import type { MatchConfig, TeamSide } from '@skoriva/shared';

export interface VolleyballSet {
  home: number;
  away: number;
  winner?: TeamSide;
}

export interface VolleyballState extends Record<string, unknown> {
  sets: VolleyballSet[];
  currentSet: number;
  setsWon: { home: number; away: number };
  periodActionCount: number;
}

export function initVolleyballState(_config: MatchConfig): VolleyballState {
  return {
    sets: [{ home: 0, away: 0 }],
    currentSet: 0,
    setsWon: { home: 0, away: 0 },
    periodActionCount: 0,
  };
}
