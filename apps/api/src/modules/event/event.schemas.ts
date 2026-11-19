/**
 * Local Event REST schemas (T-30).
 *
 * Mirrors the shared Event contracts without importing runtime values from
 * `@skoriva/shared` (the compiled API cannot execute shared TS sources).
 * `ownerId` and `archived` are never accepted from the client.
 */

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { ApiError } from '../../middleware/error.js';

export const createEventSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sport: z.enum(['basketball', 'futsal', 'badminton', 'volleyball']),
    parentId: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    date: z.coerce.date().optional(),
  })
  .strict();

export const updateEventSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    date: z.coerce.date().optional(),
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

export type CreateEventBody = z.infer<typeof createEventSchema>;
export type UpdateEventBody = z.infer<typeof updateEventSchema>;

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
