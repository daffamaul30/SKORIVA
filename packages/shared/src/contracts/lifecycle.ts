/**
 * Match lifecycle REST payloads (Tech Spec §3.2; B-06).
 *
 * Lifecycle transitions travel over REST and always carry idempotency and
 * concurrency guards. The operator session proof (`X-Operator-Session`) is a
 * header, not a body field (R-01).
 *
 * `correct-result` additionally requires a mandatory reason and a
 * sport-specific correction payload (B-10).
 */

import { z } from 'zod';
import type { Sport } from '../domain/sport.js';
import { expectedVersionSchema, nonEmptyString, TEXT_LIMITS, txIdSchema } from './common.js';
import { finalScoreCorrectionSchema, setsAndPointsCorrectionSchema } from './correction.js';

/** `start`, `finish`, `cancel`, `reopen`, `save-result`, `discard-result`, `restore-result`. */
export const lifecycleActionSchema = z
  .object({
    txId: txIdSchema,
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const correctResultSchema = z
  .object({
    txId: txIdSchema,
    expectedVersion: expectedVersionSchema,
    reason: nonEmptyString(TEXT_LIMITS.correctionReason),
    correction: z.union([finalScoreCorrectionSchema, setsAndPointsCorrectionSchema]),
  })
  .strict();

/**
 * Correction schema bound to a known match sport. This prevents a
 * volleyball-shaped correction from being accepted for a basketball match
 * before the sport engine runs.
 */
export function correctResultSchemaForSport(sport: Sport) {
  const correction =
    sport === 'basketball' || sport === 'futsal'
      ? finalScoreCorrectionSchema
      : setsAndPointsCorrectionSchema;

  return correctResultSchema.extend({ correction });
}

export type LifecycleActionInput = z.infer<typeof lifecycleActionSchema>;
export type CorrectResultInput = z.infer<typeof correctResultSchema>;
