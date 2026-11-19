/**
 * Sport-specific correction schemas (B-10; Tech Spec §3.2).
 *
 * Basketball/Futsal: `{ homeScore, awayScore }`
 * Volleyball/Badminton: `{ sets, points }`
 *
 * The sport is not part of the payload; the server knows it from the match.
 * Corrections never change `matchStatus` or `resultDecision` (LC-05).
 */

import { z } from 'zod';
import type { ResultCorrection } from '../domain/correction.js';
import { teamSideSchema } from './common.js';

export const finalScoreCorrectionSchema = z
  .object({
    homeScore: z.number().int().nonnegative(),
    awayScore: z.number().int().nonnegative(),
  })
  .strict();

export const setScoreSchema = z
  .object({
    home: z.number().int().nonnegative(),
    away: z.number().int().nonnegative(),
    winner: teamSideSchema.optional(),
  })
  .strict();

export const setsAndPointsCorrectionSchema = z
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

/**
 * Union of the two correction shapes. The API selects the applicable shape
 * from the match sport; use `correctResultSchemaForSport` in lifecycle routes.
 */
export const resultCorrectionSchema = z.union([
  finalScoreCorrectionSchema,
  setsAndPointsCorrectionSchema,
]) satisfies z.ZodType<ResultCorrection>;

export type ResultCorrectionInput = z.infer<typeof resultCorrectionSchema>;
