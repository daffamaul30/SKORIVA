/**
 * Match configuration wire schemas (PRD FR-03, Tech Spec §2.3 `matches.config`).
 *
 * Key rules:
 * - A clock without a timer has no duration fields: `{ mode: 'none' }`.
 * - A disabled shot clock has no duration: `{ enabled: false }`.
 * - **There is no timeout field, and unknown keys are rejected** (B-03).
 * - Numeric ranges are intentionally loose here; final ranges are validated in
 *   T-19 (PRD OQ #5). T-03 validates structure and sport consistency only.
 */

import { z } from 'zod';
import type {
  BadmintonConfig,
  GameClockConfig,
  MatchConfig,
  PeriodConfig,
  ScoringConfig,
  ShotClockConfig,
  VolleyballConfig,
} from '../domain/match-config.js';
import { nonEmptyString, TEXT_LIMITS } from './common.js';

/** Positive finite number of milliseconds. */
const durationMsSchema = z.number().int().positive();

export const periodConfigSchema = z
  .object({
    count: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    labels: z.array(nonEmptyString(TEXT_LIMITS.periodLabel)).min(1).optional(),
  })
  .strict() satisfies z.ZodType<PeriodConfig>;

export const gameClockSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('timed'), allowStop: z.boolean() }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
]) satisfies z.ZodType<GameClockConfig>;

export const shotClockSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(true), durationMs: durationMsSchema }).strict(),
  z.object({ enabled: z.literal(false) }).strict(),
]) satisfies z.ZodType<ShotClockConfig>;

export const scoringSchema = z
  .object({
    pointsPerGoal: z.array(z.number().int().positive()).min(1),
  })
  .strict() satisfies z.ZodType<ScoringConfig>;

export const volleyballConfigSchema = z
  .object({
    bestOf: z.union([z.literal(3), z.literal(5)]),
    pointTarget: z.number().int().positive(),
    tiebreakTarget: z.number().int().positive(),
    winByDiff: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<VolleyballConfig>;

export const badmintonConfigSchema = z
  .object({
    bestOf: z.literal(3),
    pointTarget: z.number().int().positive(),
    winByDiff: z.number().int().positive(),
    pointCap: z.number().int().positive(),
    intervalAt: z.number().int().positive(),
    intervalDurationMs: durationMsSchema,
    changeEndsAtDecidingSet: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<BadmintonConfig>;

export const matchConfigSchema = z
  .object({
    periods: periodConfigSchema,
    gameClock: gameClockSchema,
    shotClock: shotClockSchema,
    scoring: scoringSchema,
    volleyball: volleyballConfigSchema.optional(),
    badminton: badmintonConfigSchema.optional(),
  })
  .strict() satisfies z.ZodType<MatchConfig>;

export type MatchConfigInput = z.infer<typeof matchConfigSchema>;
