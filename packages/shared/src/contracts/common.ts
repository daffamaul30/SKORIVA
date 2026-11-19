/**
 * Shared primitives for the Zod contracts (Task T-03).
 *
 * These schemas are the single runtime source of truth for wire payloads.
 * Domain types in `src/domain` remain the source of truth for persisted
 * documents and engine state; schemas that mirror a domain type are pinned to
 * it with `satisfies z.ZodType<...>` and followed by type-level tests.
 *
 * There is deliberately no timeout schema and no tournament schema (B-03,
 * PRD D-01).
 */

import { z } from 'zod';
import type { MatchStatus, ResultDecision } from '../domain/match.js';
import { MATCH_STATUSES, RESULT_DECISIONS } from '../domain/match.js';
import type { Sport } from '../domain/sport.js';
import { SPORTS } from '../domain/sport.js';
import type { TeamSide } from '../domain/team.js';
import { TEAM_SIDES } from '../domain/team.js';

/**
 * Defensive MVP validation bounds. These are technical limits, not permanent
 * product decisions.
 */
export const TEXT_LIMITS = {
  matchId: 128,
  eventId: 128,
  txId: 128,
  teamName: 80,
  teamAbbr: 8,
  teamColor: 32,
  eventName: 120,
  eventDescription: 500,
  correctionReason: 500,
  stageLabel: 80,
  periodLabel: 40,
} as const;

/** Trimmed non-empty string with a maximum length. */
export function nonEmptyString(max: number) {
  return z.string().trim().min(1).max(max);
}

export const idSchema = nonEmptyString(TEXT_LIMITS.matchId);
export const eventIdSchema = nonEmptyString(TEXT_LIMITS.eventId);
export const txIdSchema = nonEmptyString(TEXT_LIMITS.txId);

/** State version / expected version guard. Must be a non-negative integer. */
export const expectedVersionSchema = z.number().int().nonnegative();

/** ISO date input accepted from JSON; the output is a `Date`. */
export const dateSchema = z.coerce.date();

export const sportSchema = z.enum(SPORTS as unknown as [Sport, ...Sport[]]);
export const teamSideSchema = z.enum(TEAM_SIDES as unknown as [TeamSide, ...TeamSide[]]);
export const matchStatusSchema = z.enum(
  MATCH_STATUSES as unknown as [MatchStatus, ...MatchStatus[]],
);
export const resultDecisionSchema = z.enum(
  RESULT_DECISIONS as unknown as [ResultDecision, ...ResultDecision[]],
);
