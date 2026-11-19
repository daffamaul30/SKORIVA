/**
 * Badminton default configuration — BWF full rules (PRD B-02, Tech Spec §4.7).
 *
 * This file only *declares* the BWF rule parameters needed by the MVP and the
 * regulatory baseline. The Badminton engine itself is implemented separately in
 * `apps/api/src/sports/badminton/` (T-22).
 *
 * Baseline R-05:
 *   Dokumen   : BWF Laws of Badminton
 *   Versi     : 26 April 2025, Version 5.0
 *   Sumber    : https://corporate.bwfbadminton.com/statutes/
 *   Verifikasi: 2026-11-13
 *   Catatan   : BWF juga mencantumkan Laws of Badminton effective
 *               4 January 2027 V2, tetapi versi tersebut BELUM BERLAKU pada
 *               tanggal verifikasi.
 *
 * - Best of 3 sets
 * - Set to 21 points, win by 2, cap 30
 * - Interval at 11 points
 * - Change ends in the deciding set at 11 points
 * - Auto-advance set when a set is won
 * - No `period.prev`; no direct decrement (FIX-04)
 * - **No timeout** (B-03 / BR-21)
 *
 * @verify Article-level details (service rotation, interval duration,
 *         change-ends procedure) are verified during T-22 implementation
 *         against the official R-05 PDF and must not be assumed here.
 */

import type { BadmintonSportConfig } from '../domain/match-config.js';

export const BADMINTON_BEST_OF = 3 as const;
export const BADMINTON_POINT_TARGET = 21;
export const BADMINTON_WIN_BY_DIFF = 2;
export const BADMINTON_POINT_CAP = 30;
export const BADMINTON_INTERVAL_AT = 11;
export const BADMINTON_INTERVAL_DURATION_MS = 60 * 1000;
export const BADMINTON_CHANGE_ENDS_AT_DECIDING_SET = 11;
export const BADMINTON_RALLY_POINTS = [1] as const;

/** Regulatory baseline recorded with the constants (R-05). */
export const BADMINTON_RULES_BASELINE = {
  document: 'BWF Laws of Badminton',
  version: '26 April 2025, Version 5.0',
  source: 'https://corporate.bwfbadminton.com/statutes/',
  verifiedAt: '2026-11-13',
  note: 'Laws of Badminton effective 4 January 2027 V2 belum berlaku pada tanggal verifikasi; tinjau ulang sebelum rilis.',
} as const;

/** Temporary validation bounds — see @verify above. */
export const BADMINTON_LIMITS = {
  minPointTarget: 1,
  maxPointTarget: 30,
  minWinByDiff: 1,
  maxWinByDiff: 5,
  minPointCap: 21,
  maxPointCap: 40,
} as const;

/**
 * Badminton is scored without a match clock (PRD B-02 / Tech Spec §4.7).
 * There is no `durationMs` placeholder: `gameClock` carries no timing fields.
 */
export const BADMINTON_DEFAULTS: BadmintonSportConfig = {
  periods: {
    count: BADMINTON_BEST_OF,
    // Badminton sets are terminated by points, not by time. The generic
    // `PeriodConfig.durationMs` is still required by the shared shape, so it is
    // set to 0 to express "no timed period duration"; it is never read while
    // `gameClock.mode === 'none'`.
    durationMs: 0,
    labels: ['Set 1', 'Set 2', 'Set 3'],
  },
  gameClock: { mode: 'none' },
  shotClock: { enabled: false },
  scoring: { pointsPerGoal: [...BADMINTON_RALLY_POINTS] },
  badminton: {
    bestOf: BADMINTON_BEST_OF,
    pointTarget: BADMINTON_POINT_TARGET,
    winByDiff: BADMINTON_WIN_BY_DIFF,
    pointCap: BADMINTON_POINT_CAP,
    intervalAt: BADMINTON_INTERVAL_AT,
    intervalDurationMs: BADMINTON_INTERVAL_DURATION_MS,
    changeEndsAtDecidingSet: BADMINTON_CHANGE_ENDS_AT_DECIDING_SET,
  },
};
