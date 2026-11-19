/**
 * Operational action schemas (Tech Spec §3.3, §4.4).
 *
 * - `matchActionSchema` validates the action body `{ type, payload }` and
 *   mirrors the domain `MatchAction` union.
 * - `matchActionInputSchema` adds the mandatory `txId` and `expectedVersion`
 *   guards required for every action (FR-11, §4.1).
 *
 * Deliberately absent:
 * - `score.decrement` — Badminton has no direct decrement; correction uses
 *   Undo (FIX-04).
 * - `timeout` — disabled for the whole MVP (B-03).
 *
 * `score.change.points` accepts any non-zero integer, including negative
 * values. Volleyball needs decrement in some cases; the sport engine decides
 * whether a decrement is legal, and Badminton rejects direct decrements. The
 * schema must not bypass those sport-specific validations.
 */

import { z } from 'zod';
import type { MatchAction } from '../domain/action.js';
import { teamSideSchema, txIdSchema, expectedVersionSchema } from './common.js';

const emptyPayloadSchema = z.object({}).strict();

const scoreChangePayloadSchema = z
  .object({
    side: teamSideSchema,
    points: z
      .number()
      .int()
      .refine((value) => value !== 0, { message: 'points must not be zero.' }),
  })
  .strict();

const clockPayloadSchema = z
  .object({
    remainingMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const clockConfirmPayloadSchema = clockPayloadSchema;

const sidePayloadSchema = z
  .object({
    side: teamSideSchema,
  })
  .strict();

const cardPayloadSchema = z
  .object({
    side: teamSideSchema,
    card: z.enum(['yellow', 'red']),
  })
  .strict();

const badmintonIntervalPayloadSchema = z
  .object({
    action: z.enum(['start', 'end']),
  })
  .strict();

const undoPayloadSchema = z
  .object({
    targetSeq: z.number().int().positive(),
  })
  .strict();

function action<T extends MatchAction['type'], P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload }).strict();
}

function actionInput<T extends MatchAction['type'], P extends z.ZodTypeAny>(type: T, payload: P) {
  return z
    .object({
      txId: txIdSchema,
      expectedVersion: expectedVersionSchema,
      type: z.literal(type),
      payload,
    })
    .strict();
}

/** Action body `{ type, payload }` mirroring the domain union exactly. */
export const matchActionSchema = z.discriminatedUnion('type', [
  action('score.change', scoreChangePayloadSchema),
  action('clock.start', clockPayloadSchema),
  action('clock.pause', clockPayloadSchema),
  action('clock.resume', clockPayloadSchema),
  action('clock.reset', clockPayloadSchema),
  action('clock.confirm', clockConfirmPayloadSchema),
  action('period.next', emptyPayloadSchema),
  action('period.prev', emptyPayloadSchema),
  action('shotClock.reset', emptyPayloadSchema),
  action('possession.set', sidePayloadSchema),
  action('foul.add', sidePayloadSchema),
  action('card.add', cardPayloadSchema),
  action('badminton.serve.change', sidePayloadSchema),
  action('badminton.interval', badmintonIntervalPayloadSchema),
  action('badminton.changeEnds', emptyPayloadSchema),
  action('match.undo', undoPayloadSchema),
]) satisfies z.ZodType<MatchAction>;

/**
 * Full action input for Socket.IO: `{ txId, expectedVersion, type, payload }`.
 *
 * Enumerates the same payload schemas as `matchActionSchema`; the type test in
 * `action.test.ts` pins the two definitions together so they cannot drift.
 */
export const matchActionInputSchema = z.discriminatedUnion('type', [
  actionInput('score.change', scoreChangePayloadSchema),
  actionInput('clock.start', clockPayloadSchema),
  actionInput('clock.pause', clockPayloadSchema),
  actionInput('clock.resume', clockPayloadSchema),
  actionInput('clock.reset', clockPayloadSchema),
  actionInput('clock.confirm', clockConfirmPayloadSchema),
  actionInput('period.next', emptyPayloadSchema),
  actionInput('period.prev', emptyPayloadSchema),
  actionInput('shotClock.reset', emptyPayloadSchema),
  actionInput('possession.set', sidePayloadSchema),
  actionInput('foul.add', sidePayloadSchema),
  actionInput('card.add', cardPayloadSchema),
  actionInput('badminton.serve.change', sidePayloadSchema),
  actionInput('badminton.interval', badmintonIntervalPayloadSchema),
  actionInput('badminton.changeEnds', emptyPayloadSchema),
  actionInput('match.undo', undoPayloadSchema),
]);

export type MatchActionInput = z.infer<typeof matchActionInputSchema>;
