/**
 * Match configuration types (PRD FR-03, Tech Spec §2.3 `matches.config`).
 *
 * MVP constraints encoded here:
 * - **No timeout** configuration anywhere (B-03 / BR-21).
 * - **Volleyball never has a game clock** (`mode: 'none'`);
 *   a config without a timer carries no duration fields at all.
 * - Numbers documented as OPEN (PRD OQ #5, "rentang numerik konfigurasi")
 *   are limits/validation ranges, not defaults. Concrete validation ranges
 *   are implemented in T-19 (Zod config validation).
 */

import type { Sport } from './sport.js';

/** Game clock modes (PRD FR-03: timer aktif atau nonaktif). */
export type GameClockMode = 'timed' | 'none';

/**
 * Game clock settings.
 *
 * A clock without a running timer must not carry duration placeholders:
 * `mode: 'none'` has no `durationMs` / `allowStop` fields at all.
 */
export type GameClockConfig =
  | {
      mode: 'timed';
      /** Whether the operator may stop the clock (Futsal option). */
      allowStop: boolean;
    }
  | {
      mode: 'none';
    };

export interface PeriodConfig {
  count: number;
  durationMs: number;
  /** Optional period labels, e.g. `['Q1', 'Q2', 'Q3', 'Q4']`. */
  labels?: string[];
}

/**
 * Shot clock settings. Only Basketball enables it (Tech Spec §4.7).
 * Disabled shot clock carries no duration.
 */
export type ShotClockConfig =
  | {
      enabled: true;
      durationMs: number;
    }
  | {
      enabled: false;
    };

export interface ScoringConfig {
  /** Points granted per goal, e.g. `[1]` (Futsal) or `[1, 2, 3]` (Basketball). */
  pointsPerGoal: number[];
}

/** Volleyball set rules (PRD FR-03, Tech Spec §4.7). */
export interface VolleyballConfig {
  bestOf: 3 | 5;
  /** Points required to win a regular set. */
  pointTarget: number;
  /** Points required to win the deciding set (tiebreak). */
  tiebreakTarget: number;
  /** Minimum point difference required to win a set. */
  winByDiff: number;
}

/**
 * Badminton rules (BWF full rules, PRD B-02 / Tech Spec §4.7).
 *
 * Baseline R-05: BWF Laws of Badminton, 26 April 2025, Version 5.0.
 * Article-level details that cannot be confirmed from the official PDF must be
 * verified during engine implementation (T-22), not assumed here.
 */
export interface BadmintonConfig {
  bestOf: 3;
  pointTarget: number;
  winByDiff: number;
  pointCap: number;
  /** Point value at which the mid-game interval is taken. */
  intervalAt: number;
  intervalDurationMs: number;
  /** Point value in the deciding set at which players change ends. */
  changeEndsAtDecidingSet: number;
}

export interface MatchConfig {
  periods: PeriodConfig;
  gameClock: GameClockConfig;
  shotClock: ShotClockConfig;
  scoring: ScoringConfig;
  volleyball?: VolleyballConfig;
  badminton?: BadmintonConfig;
}

/**
 * Sport-specific configuration payload.
 *
 * `MatchConfig` above covers the shared, sport-agnostic portion; each sport's
 * defaults are typed precisely in `src/constants/<sport>.ts`.
 */
export interface SportConfigBySport {
  basketball: BasketballSportConfig;
  futsal: FutsalSportConfig;
  badminton: BadmintonSportConfig;
  volleyball: VolleyballSportConfig;
}

export interface BasketballSportConfig extends MatchConfig {
  gameClock: Extract<GameClockConfig, { mode: 'timed' }>;
  shotClock: Extract<ShotClockConfig, { enabled: true }>;
  scoring: { pointsPerGoal: number[] };
  volleyball?: never;
  badminton?: never;
}

export interface FutsalSportConfig extends MatchConfig {
  /**
   * Futsal may run with a timed clock or with the timer disabled
   * (PRD FR-03 AC; Tech Spec §4.7). The default remains `timed`.
   */
  gameClock: GameClockConfig;
  shotClock: { enabled: false };
  scoring: { pointsPerGoal: number[] };
  volleyball?: never;
  badminton?: never;
}

export interface BadmintonSportConfig extends MatchConfig {
  /** Badminton is played and scored without a match clock (PRD B-02 / §4.7). */
  gameClock: { mode: 'none' };
  shotClock: { enabled: false };
  scoring: { pointsPerGoal: number[] };
  badminton: BadmintonConfig;
  volleyball?: never;
}

export interface VolleyballSportConfig extends MatchConfig {
  /** Volleyball always runs without a clock (Tech Spec §4.7). */
  gameClock: { mode: 'none' };
  shotClock: { enabled: false };
  scoring: { pointsPerGoal: number[] };
  volleyball: VolleyballConfig;
  badminton?: never;
}

export type SportConfigFor<S extends Sport> = SportConfigBySport[S];
