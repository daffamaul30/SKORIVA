/**
 * Futsal default configuration (PRD FR-03, Tech Spec §4.7).
 *
 * - 2 × 20 minutes
 * - Goal +1
 * - Yellow/red cards are simple counters with no automatic effect (D-09)
 * - **No timeout** (B-03 / BR-21)
 *
 * @verify OPEN (PRD OQ #5) — numeric min/max ranges are not final.
 *         The limits below are validation bounds implemented in T-19.
 */

import type { FutsalSportConfig } from '../domain/match-config.js';

export const FUTSAL_PERIOD_COUNT = 2;
export const FUTSAL_PERIOD_DURATION_MS = 20 * 60 * 1000;
export const FUTSAL_PERIOD_LABELS = ['1st Half', '2nd Half'] as const;
export const FUTSAL_GOAL_POINTS = [1] as const;

/** Temporary validation bounds — see @verify above. */
export const FUTSAL_LIMITS = {
  minPeriodCount: 1,
  maxPeriodCount: 4,
  minPeriodDurationMs: 60 * 1000,
  maxPeriodDurationMs: 30 * 60 * 1000,
} as const;

export const FUTSAL_DEFAULTS: FutsalSportConfig = {
  periods: {
    count: FUTSAL_PERIOD_COUNT,
    durationMs: FUTSAL_PERIOD_DURATION_MS,
    labels: [...FUTSAL_PERIOD_LABELS],
  },
  // Timer aktif dengan opsi berhenti (PRD FR-03 AC: operator dapat menonaktifkan timer futsal).
  gameClock: { mode: 'timed', allowStop: true },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [...FUTSAL_GOAL_POINTS] },
};
