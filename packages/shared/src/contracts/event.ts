/**
 * Event REST payload schemas (PRD FR-23; Tech Spec §3.2).
 *
 * Rules encoded here:
 * - `name` and `sport` are required on create; one event is one sport (BR-18).
 * - `parentId` is optional; depth and sport equality are validated server-side
 *   because they need the parent document (BR-15/BR-18).
 * - `ownerId` is never accepted from the client: it comes from the authenticated
 *   account (B-05).
 * - `archived` is never accepted from the client; archiving has its own action.
 * - PATCH only allows name, description, and date (Tech Spec §3.2).
 */

import { z } from 'zod';
import { dateSchema, eventIdSchema, nonEmptyString, sportSchema, TEXT_LIMITS } from './common.js';

export const createEventSchema = z
  .object({
    name: nonEmptyString(TEXT_LIMITS.eventName),
    sport: sportSchema,
    parentId: eventIdSchema.optional(),
    description: nonEmptyString(TEXT_LIMITS.eventDescription).optional(),
    date: dateSchema.optional(),
  })
  .strict();

export const updateEventSchema = z
  .object({
    name: nonEmptyString(TEXT_LIMITS.eventName).optional(),
    description: nonEmptyString(TEXT_LIMITS.eventDescription).optional(),
    date: dateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.name === undefined && value.description === undefined && value.date === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of name, description, or date must be provided.',
      });
    }
  });

export const archiveEventSchema = z.object({}).strict();

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
