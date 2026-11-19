/**
 * Sport identifiers for the MVP.
 *
 * MVP scope (PRD D-11): Basketball, Futsal, Badminton, Volleyball.
 * Soccer/Football is explicitly out of scope.
 */

export const SPORTS = ['basketball', 'futsal', 'badminton', 'volleyball'] as const;

export type Sport = (typeof SPORTS)[number];

export function isSport(value: unknown): value is Sport {
  return typeof value === 'string' && (SPORTS as readonly string[]).includes(value);
}

/**
 * Sports that have a full BWF rule set requirement (PRD B-02 / Tech Spec §4.7).
 *
 * This only marks that Badminton *requires* a BWF-complete sport engine.
 * The engine implementation lives in `apps/api/src/sports/badminton/` (T-22)
 * and is not part of the shared package.
 */
export const SPORTS_REQUIRING_FULL_RULESET = ['badminton'] as const satisfies readonly Sport[];

export type FullRulesetSport = (typeof SPORTS_REQUIRING_FULL_RULESET)[number];
