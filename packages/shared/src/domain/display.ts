/**
 * Minimal viewer display contract (B-07 / Tech Spec §4.6).
 *
 * The viewer receives only: team names, logo if available, score, clock,
 * period/set, status, and shot clock when relevant. For Badminton the viewer
 * additionally receives `servingSide` and `serviceCourt` (FIX-05).
 *
 * Explicitly excluded: event timeline, player statistics, roster, officials,
 * event log, and any internal state.
 */

import type { MatchStatus, ResultDecision } from './match.js';
import type { TeamSide } from './team.js';

/** Arbitrary point total; Volleyball derives it from sets won + current points. */
export interface ScoreboardScore {
  home: number;
  away: number;
}

/** Score per set/side. */
export interface ScoreboardSetScore {
  home: number;
  away: number;
  winner?: TeamSide;
}

export interface ScoreboardTeam {
  name: string;
  abbr?: string;
  color?: string;
  logoUrl?: string;
}

/** Clock as shown to viewers; absent when the sport has no clock. */
export interface ScoreboardClock {
  remainingMs: number;
  isRunning: boolean;
}

/** Shot clock as shown to viewers; Basketball only. */
export interface ScoreboardShotClock {
  remainingMs: number;
  running: boolean;
  expired: boolean;
}

/** Badminton service indicator (FIX-05: two public fields only). */
export interface ScoreboardBadmintonServe {
  servingSide: TeamSide;
  serviceCourt: 'right' | 'left';
}

/**
 * Sport-id of the viewer payload. Even the sport identifier is scoped
 * per match; it is not internal state.
 */
export interface ScoreboardView {
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  teams: { home: ScoreboardTeam; away: ScoreboardTeam };
  score: ScoreboardScore;
  period: {
    index: number;
    label: string;
    /** Some sports expose a set number instead of a period. */
    total?: number;
  };
  clock?: ScoreboardClock;
  shotClock?: ScoreboardShotClock;
  sets?: ScoreboardSetScore[];
  badmintonServe?: ScoreboardBadmintonServe;
}
