/**
 * Match REST payload schemas (PRD FR-01…FR-04; Tech Spec §3.2).
 *
 * Cross-resource rules BR-15 (match sport = event sport) and B-04 (same-owner)
 * need the event document and are enforced by the API layer (T-19/T-30). The
 * schema carries `context.eventId` so those checks can run server-side.
 *
 * Rules encoded here:
 * - Required create inputs: sport, home team, away team (FR-01).
 * - Team names must differ; colors must differ when both are set (FR-02).
 * - Config, when supplied, must match the selected sport's clock structure.
 * - There is no timeout field anywhere (B-03).
 * - No owner/access/state fields: the server derives them.
 */

import { z } from 'zod';
import type { MatchContext } from '../domain/match.js';
import type { Sport } from '../domain/sport.js';
import { matchConfigSchema } from './config.js';
import { nonEmptyString, sportSchema, TEXT_LIMITS } from './common.js';
import { teamsSchema } from './team.js';

export const matchContextSchema = z
  .object({
    eventId: nonEmptyString(TEXT_LIMITS.eventId).optional(),
    stageLabel: nonEmptyString(TEXT_LIMITS.stageLabel).optional(),
    matchNumber: z.number().int().positive().optional(),
  })
  .strict() satisfies z.ZodType<MatchContext>;

/**
 * Structural config/sport consistency. Numeric ranges are validated later in
 * T-19; this only prevents contradictory combinations.
 */
function refineConfigForSport(
  config: z.infer<typeof matchConfigSchema>,
  sport: Sport,
  ctx: z.RefinementCtx,
): void {
  switch (sport) {
    case 'basketball':
      if (config.gameClock.mode !== 'timed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'gameClock', 'mode'],
          message: 'Basketball requires a timed game clock.',
        });
      }
      if (!config.shotClock.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'shotClock', 'enabled'],
          message: 'Basketball requires an enabled shot clock.',
        });
      }
      if (config.volleyball !== undefined || config.badminton !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: 'Basketball config must not contain volleyball/badminton settings.',
        });
      }
      return;

    case 'futsal':
      // Futsal may run timed or with the timer disabled (PRD FR-03 AC).
      if (config.shotClock.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'shotClock', 'enabled'],
          message: 'Futsal does not use a shot clock.',
        });
      }
      if (config.volleyball !== undefined || config.badminton !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: 'Futsal config must not contain volleyball/badminton settings.',
        });
      }
      return;

    case 'badminton':
      if (config.gameClock.mode !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'gameClock', 'mode'],
          message: 'Badminton does not use a game clock.',
        });
      }
      if (config.shotClock.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'shotClock', 'enabled'],
          message: 'Badminton does not use a shot clock.',
        });
      }
      if (config.badminton === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'badminton'],
          message: 'Badminton config is required for badminton matches.',
        });
      }
      if (config.volleyball !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'volleyball'],
          message: 'Badminton config must not contain volleyball settings.',
        });
      }
      return;

    case 'volleyball':
      if (config.gameClock.mode !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'gameClock', 'mode'],
          message: 'Volleyball never uses a game clock.',
        });
      }
      if (config.shotClock.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'shotClock', 'enabled'],
          message: 'Volleyball does not use a shot clock.',
        });
      }
      if (config.volleyball === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'volleyball'],
          message: 'Volleyball config is required for volleyball matches.',
        });
      }
      if (config.badminton !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'badminton'],
          message: 'Volleyball config must not contain badminton settings.',
        });
      }
      return;

    default: {
      const unreachable: never = sport;
      throw new Error(`Unsupported sport: ${String(unreachable)}`);
    }
  }
}

export const createMatchSchema = z
  .object({
    sport: sportSchema,
    teams: teamsSchema,
    config: matchConfigSchema.optional(),
    context: matchContextSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.config !== undefined) {
      refineConfigForSport(value.config, value.sport, ctx);
    }
  });

export const updateMatchSchema = z
  .object({
    teams: teamsSchema.optional(),
    config: matchConfigSchema.optional(),
    context: matchContextSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.teams === undefined && value.config === undefined && value.context === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of teams, config, or context must be provided.',
      });
    }
  });

/**
 * Update payload bound to a known match sport. Use this in API handlers where
 * `match.sport` is already loaded; keep `updateMatchSchema` for transport-level
 * parsing before the match is fetched.
 */
export function updateMatchSchemaForSport(sport: Sport) {
  return updateMatchSchema.superRefine((value, ctx) => {
    if (value.config !== undefined) {
      refineConfigForSport(value.config, sport, ctx);
    }
  });
}

export type MatchContextInput = z.infer<typeof matchContextSchema>;
export type CreateMatchInput = z.infer<typeof createMatchSchema>;
export type UpdateMatchInput = z.infer<typeof updateMatchSchema>;
