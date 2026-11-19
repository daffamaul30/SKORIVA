/**
 * Team model (PRD FR-02, Tech Spec §2.3 `matches.teams`).
 * Players/rosters are intentionally absent (PRD BR-05, AS-03).
 */

export const TEAM_SIDES = ['home', 'away'] as const;

export type TeamSide = (typeof TEAM_SIDES)[number];

/** Opposing side of a `TeamSide`. */
export const OPPOSITE_SIDE: Readonly<Record<TeamSide, TeamSide>> = {
  home: 'away',
  away: 'home',
};

export interface Team {
  /** Required. MVP technical limit: 80 characters (see `TEXT_LIMITS.teamName`). */
  name: string;
  /** Optional short label shown on the scoreboard. Limit: 8 characters. */
  abbr?: string;
  /** Optional team color; home and away must not be identical (PRD FR-02). Limit: 32 characters. */
  color?: string;
}

export interface MatchTeams {
  home: Team;
  away: Team;
}
