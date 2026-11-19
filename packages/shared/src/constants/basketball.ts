/**
 * Basketball default configuration (PRD FR-03, Tech Spec §4.7).
 *
 * - 4 quarters × 10 minutes, labels Q1–Q4
 * - Shot clock 24 s (stored in `sportState`, not in the core clock — BR-13)
 * - Score +1 / +2 / +3
 * - Foul is a simple counter (no foul-out, no bonus)
 * - **No timeout** (B-03 / BR-21)
 *
 * @verify OPEN (PRD OQ #5) — numeric min/max ranges are not final.
 *         The limits below are validation bounds implemented in T-19.
 */

import type { BasketballSportConfig } from '../domain/match-config.js';

export const BASKETBALL_QUARTER_COUNT = 4;
export const BASKETBALL_PERIOD_DURATION_MS = 10 * 60 * 1000;
export const BASKETBALL_PERIOD_LABELS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
export const BASKETBALL_SHOT_CLOCK_MS = 24 * 1000;
export const BASKETBALL_GOAL_POINTS = [1, 2, 3] as const;

/** Temporary validation bounds — see @verify above. */
export const BASKETBALL_LIMITS = {
  minPeriodCount: 1,
  maxPeriodCount: 8,
  minPeriodDurationMs: 60 * 1000,
  maxPeriodDurationMs: 20 * 60 * 1000,
  minShotClockMs: 10 * 1000,
  maxShotClockMs: 40 * 1000,
} as const;

export const BASKETBALL_DEFAULTS: BasketballSportConfig = {
  periods: {
    count: BASKETBALL_QUARTER_COUNT,
    durationMs: BASKETBALL_PERIOD_DURATION_MS,
    labels: [...BASKETBALL_PERIOD_LABELS],
  },
  gameClock: { mode: 'timed', allowStop: true },
  shotClock: { enabled: true, durationMs: BASKETBALL_SHOT_CLOCK_MS },
  scoring: { pointsPerGoal: [...BASKETBALL_GOAL_POINTS] },
};
