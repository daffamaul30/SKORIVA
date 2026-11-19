/**
 * Runtime defaults and validation bounds used by the sport engines (T-19).
 *
 * `@skoriva/shared` exports these values as TypeScript sources. The compiled API
 * cannot import runtime values from that package (its `main` points at a `.ts`
 * file), so the values are mirrored here. `tests/sports/config-validation.test.ts`
 * asserts parity with the shared exports to prevent drift.
 *
 * Numeric bounds are the documented temporary validation ranges (PRD OQ #5).
 */

import type {
  BadmintonSportConfig,
  BasketballSportConfig,
  FutsalSportConfig,
  VolleyballSportConfig,
} from '@skoriva/shared';

export const BASKETBALL_DEFAULTS: BasketballSportConfig = {
  periods: {
    count: 4,
    durationMs: 10 * 60 * 1000,
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
  },
  gameClock: { mode: 'timed', allowStop: true },
  shotClock: { enabled: true, durationMs: 24 * 1000 },
  scoring: { pointsPerGoal: [1, 2, 3] },
};

export const BASKETBALL_LIMITS = {
  minPeriodCount: 1,
  maxPeriodCount: 8,
  minPeriodDurationMs: 60 * 1000,
  maxPeriodDurationMs: 20 * 60 * 1000,
  minShotClockMs: 10 * 1000,
  maxShotClockMs: 40 * 1000,
} as const;

export const FUTSAL_DEFAULTS: FutsalSportConfig = {
  periods: {
    count: 2,
    durationMs: 20 * 60 * 1000,
    labels: ['1st Half', '2nd Half'],
  },
  gameClock: { mode: 'timed', allowStop: true },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [1] },
};

export const FUTSAL_LIMITS = {
  minPeriodCount: 1,
  maxPeriodCount: 4,
  minPeriodDurationMs: 60 * 1000,
  maxPeriodDurationMs: 30 * 60 * 1000,
} as const;

export const BADMINTON_DEFAULTS: BadmintonSportConfig = {
  periods: {
    count: 3,
    durationMs: 0,
    labels: ['Set 1', 'Set 2', 'Set 3'],
  },
  gameClock: { mode: 'none' },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [1] },
  badminton: {
    bestOf: 3,
    pointTarget: 21,
    winByDiff: 2,
    pointCap: 30,
    intervalAt: 11,
    intervalDurationMs: 60 * 1000,
    changeEndsAtDecidingSet: 11,
  },
};

export const BADMINTON_LIMITS = {
  minPointTarget: 1,
  maxPointTarget: 30,
  minWinByDiff: 1,
  maxWinByDiff: 5,
  minPointCap: 21,
  maxPointCap: 40,
} as const;

export const VOLLEYBALL_DEFAULTS: VolleyballSportConfig = {
  periods: {
    count: 3,
    durationMs: 0,
    labels: ['Set 1', 'Set 2', 'Set 3'],
  },
  gameClock: { mode: 'none' },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [1] },
  volleyball: {
    bestOf: 3,
    pointTarget: 25,
    tiebreakTarget: 15,
    winByDiff: 2,
  },
};

export const VOLLEYBALL_LIMITS = {
  bestOfOptions: [3, 5] as const,
  minPointTarget: 15,
  maxPointTarget: 30,
  minWinByDiff: 1,
  maxWinByDiff: 5,
} as const;
