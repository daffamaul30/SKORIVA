/**
 * Local REST schemas for the Match module (T-29).
 *
 * `@skoriva/shared` exposes its Zod contracts as TypeScript sources, which the
 * compiled API cannot import at runtime. These schemas mirror the shared
 * contracts; `tests/modules/match/match.schemas.test.ts` pins them to the
 * shared schemas so they cannot drift.
 */

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { ApiError } from '../../middleware/error.js';

const TEXT = {
  teamName: 80,
  teamAbbr: 8,
  teamColor: 32,
  stageLabel: 80,
  eventId: 128,
  txId: 128,
  correctionReason: 500,
} as const;

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const teamSchema = z
  .object({
    name: nonEmpty(TEXT.teamName),
    abbr: nonEmpty(TEXT.teamAbbr).optional(),
    color: nonEmpty(TEXT.teamColor).optional(),
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
  });

const periodConfigSchema = z
  .object({
    count: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    labels: z.array(nonEmpty(40)).min(1).optional(),
  })
  .strict();

const gameClockSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('timed'), allowStop: z.boolean() }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
]);

const shotClockSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(true), durationMs: z.number().int().positive() }).strict(),
  z.object({ enabled: z.literal(false) }).strict(),
]);

const scoringSchema = z
  .object({
    pointsPerGoal: z.array(z.number().int().positive()).min(1),
  })
  .strict();

const volleyballConfigSchema = z
  .object({
    bestOf: z.union([z.literal(3), z.literal(5)]),
    pointTarget: z.number().int().positive(),
    tiebreakTarget: z.number().int().positive(),
    winByDiff: z.number().int().positive(),
  })
  .strict();

const badmintonConfigSchema = z
  .object({
    bestOf: z.literal(3),
    pointTarget: z.number().int().positive(),
    winByDiff: z.number().int().positive(),
    pointCap: z.number().int().positive(),
    intervalAt: z.number().int().positive(),
    intervalDurationMs: z.number().int().positive(),
    changeEndsAtDecidingSet: z.number().int().nonnegative(),
  })
  .strict();

export const matchConfigSchema = z
  .object({
    periods: periodConfigSchema,
    gameClock: gameClockSchema,
    shotClock: shotClockSchema,
    scoring: scoringSchema,
    volleyball: volleyballConfigSchema.optional(),
    badminton: badmintonConfigSchema.optional(),
  })
  .strict();

export const matchContextSchema = z
  .object({
    eventId: nonEmpty(TEXT.eventId).optional(),
    stageLabel: nonEmpty(TEXT.stageLabel).optional(),
    matchNumber: z.number().int().positive().optional(),
  })
  .strict();

export const createMatchSchema = z
  .object({
    sport: z.enum(['basketball', 'futsal', 'badminton', 'volleyball']),
    teams: teamsSchema,
    config: matchConfigSchema.optional(),
    context: matchContextSchema.optional(),
  })
  .strict();

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

export const lifecycleBodySchema = z
  .object({
    txId: nonEmpty(TEXT.txId),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

const finalScoreCorrectionSchema = z
  .object({
    homeScore: z.number().int().nonnegative(),
    awayScore: z.number().int().nonnegative(),
  })
  .strict();

const setScoreSchema = z
  .object({
    home: z.number().int().nonnegative(),
    away: z.number().int().nonnegative(),
    winner: z.enum(['home', 'away']).optional(),
  })
  .strict();

const setsAndPointsCorrectionSchema = z
  .object({
    sets: z.array(setScoreSchema).min(1),
    points: z
      .object({
        home: z.number().int().nonnegative(),
        away: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const correctResultBodySchema = z
  .object({
    txId: nonEmpty(TEXT.txId),
    expectedVersion: z.number().int().nonnegative(),
    reason: nonEmpty(TEXT.correctionReason),
    correction: z.union([finalScoreCorrectionSchema, setsAndPointsCorrectionSchema]),
  })
  .strict();

export const claimMatchSchema = z
  .object({
    controlToken: nonEmpty(TEXT.txId),
  })
  .strict();

export const eventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    beforeSeq: z.coerce.number().int().positive().optional(),
  })
  .strict();

export function parseRequest<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, 'VALIDATION_ERROR', message);
  }

  return result.data;
}

export type CreateMatchRequest = z.infer<typeof createMatchSchema>;
export type UpdateMatchRequest = z.infer<typeof updateMatchSchema>;
export type LifecycleBody = z.infer<typeof lifecycleBodySchema>;
export type CorrectResultBody = z.infer<typeof correctResultBodySchema>;
export type ClaimMatchBody = z.infer<typeof claimMatchSchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
