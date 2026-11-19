/**
 * Sport-specific result correction payloads (B-10 / Tech Spec §3.2, §4.4).
 *
 * Rules:
 * - Correction never changes `resultDecision` away from `saved` (LC-05).
 * - A reason is mandatory and recorded as an audit event.
 * - Historical event log rows are never mutated.
 * - Basketball/Futsal correct the final score:
 *   `{ homeScore, awayScore }`.
 * - Volleyball/Badminton correct sets and points:
 *   `{ sets, points }`; the sport engine recomputes the final score.
 *
 * The sport is known from the match being corrected and is therefore not part
 * of the wire payload (Tech Spec §3.2). The complete `result.correct` event
 * envelope (`before`, `after`, `reason`, `correction`) is assembled by the
 * core event log in T-18/T-29.
 */

import type { ScoreboardScore, ScoreboardSetScore } from './display.js';

/** Final-score correction for Basketball and Futsal (B-10). */
export interface FinalScoreCorrection {
  homeScore: number;
  awayScore: number;
}

/** Sets plus the points of the current set for Volleyball and Badminton (B-10). */
export interface SetsAndPointsCorrection {
  sets: ScoreboardSetScore[];
  points: ScoreboardScore;
}

/**
 * Sport-specific correction payload (Tech Spec §3.2).
 *
 * The discriminant is intentionally absent: the same values are valid shapes
 * for two sports each, and the server selects the applicable shape from
 * `match.sport`.
 */
export type ResultCorrection = FinalScoreCorrection | SetsAndPointsCorrection;
