/**
 * Team wire schemas (PRD FR-01, FR-02; Tech Spec §2.3 `matches.teams`).
 *
 * Rules encoded here:
 * - Team name is required and cannot be identical between home and away.
 * - Abbreviation and color are optional.
 * - If both colors are set, they cannot be identical.
 * - Players/rosters are absent (BR-05).
 */

import { z } from 'zod';
import type { MatchTeams } from '../domain/team.js';
import { nonEmptyString, TEXT_LIMITS } from './common.js';

export const teamSchema = z
  .object({
    name: nonEmptyString(TEXT_LIMITS.teamName),
    abbr: nonEmptyString(TEXT_LIMITS.teamAbbr).optional(),
    color: nonEmptyString(TEXT_LIMITS.teamColor).optional(),
  })
  .strict();

export const teamsSchema = z
  .object({
    home: teamSchema,
    away: teamSchema,
  })
  .strict()
  .superRefine((teams, ctx) => {
    if (teams.home.name === teams.away.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['away', 'name'],
        message: 'Home and away team names must differ.',
      });
    }

    if (
      teams.home.color !== undefined &&
      teams.away.color !== undefined &&
      teams.home.color.toLowerCase() === teams.away.color.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['away', 'color'],
        message: 'Home and away team colors must differ.',
      });
    }
  }) satisfies z.ZodType<MatchTeams>;

export type TeamInput = z.infer<typeof teamSchema>;
export type TeamsInput = z.infer<typeof teamsSchema>;
