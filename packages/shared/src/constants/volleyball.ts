/**
 * Volleyball default configuration (PRD FR-03, Tech Spec §4.7).
 *
 * - Best of 3 (5 optional)
 * - Set target 25 with a 2-point minimum difference
 * - Deciding set (tiebreak) to 15 with the same difference
 * - **No game clock ever** (`mode: 'none'`; `timed` config is rejected)
 * - Auto-advance set when a set is won (D-08); no `period.prev`
 * - **No timeout** (B-03 / BR-21)
 *
 * @verify OPEN (PRD OQ #5) — numeric min/max ranges are not final.
 *         The limits below are validation bounds implemented in T-19.
 */

import type { VolleyballSportConfig } from '../domain/match-config.js';

export const VOLLEYBALL_BEST_OF = 3 as const;
export const VOLLEYBALL_POINT_TARGET = 25;
export const VOLLEYBALL_TIEBREAK_TARGET = 15;
export const VOLLEYBALL_WIN_BY_DIFF = 2;
export const VOLLEYBALL_RALLY_POINTS = [1] as const;

/** Temporary validation bounds — see @verify above. */
export const VOLLEYBALL_LIMITS = {
  bestOfOptions: [3, 5] as const,
  minPointTarget: 15,
  maxPointTarget: 30,
  minWinByDiff: 1,
  maxWinByDiff: 5,
} as const;

/**
 * Volleyball has no game clock (tech spec §4.7).
 * `gameClock` is exactly `{ mode: 'none' }` — no duration placeholder.
 */
export const VOLLEYBALL_DEFAULTS: VolleyballSportConfig = {
  periods: {
    count: VOLLEYBALL_BEST_OF,
    // Sets end by points, not time. `PeriodConfig.durationMs` is part of the
    // shared generic shape only; it is never read while `gameClock.mode === 'none'`.
    durationMs: 0,
    labels: ['Set 1', 'Set 2', 'Set 3'],
  },
  gameClock: { mode: 'none' },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [...VOLLEYBALL_RALLY_POINTS] },
  volleyball: {
    bestOf: VOLLEYBALL_BEST_OF,
    pointTarget: VOLLEYBALL_POINT_TARGET,
    tiebreakTarget: VOLLEYBALL_TIEBREAK_TARGET,
    winByDiff: VOLLEYBALL_WIN_BY_DIFF,
  },
};
