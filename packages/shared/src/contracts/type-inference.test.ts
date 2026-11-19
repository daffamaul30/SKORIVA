import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { MatchAction } from '../domain/action.js';
import type { ResultCorrection } from '../domain/correction.js';
import type { MatchConfig } from '../domain/match-config.js';
import type { MatchContext } from '../domain/match.js';
import type { MatchTeams } from '../domain/team.js';
import type {
  CreateEventInput,
  MatchConfigInput,
  createEventSchema,
  createMatchSchema,
  matchActionInputSchema,
  matchActionSchema,
  matchConfigSchema,
  matchContextSchema,
  resultCorrectionSchema,
  teamsSchema,
} from './index.js';

/**
 * Type-level guarantees that the Zod contracts keep tracking the T-02 domain
 * types. A drift between them fails `pnpm typecheck`.
 */
describe('schema/domain type parity', () => {
  it('matchActionSchema parses to the exact domain union', () => {
    expectTypeOf<z.infer<typeof matchActionSchema>>().toEqualTypeOf<MatchAction>();
  });

  it('matchConfigSchema parses to the domain config', () => {
    expectTypeOf<z.infer<typeof matchConfigSchema>>().toEqualTypeOf<MatchConfig>();
  });

  it('teamsSchema parses to the domain teams', () => {
    expectTypeOf<z.infer<typeof teamsSchema>>().toEqualTypeOf<MatchTeams>();
  });

  it('matchContextSchema parses to the domain context', () => {
    expectTypeOf<z.infer<typeof matchContextSchema>>().toEqualTypeOf<MatchContext>();
  });

  it('resultCorrectionSchema parses to the domain correction', () => {
    expectTypeOf<z.infer<typeof resultCorrectionSchema>>().toEqualTypeOf<ResultCorrection>();
  });

  it('create inputs expose the inferred wire types', () => {
    expectTypeOf<z.infer<typeof createMatchSchema>>().toHaveProperty('sport');
    expectTypeOf<z.infer<typeof createMatchSchema>>().toHaveProperty('teams');
    expectTypeOf<z.infer<typeof createEventSchema>>().toHaveProperty('name');
    expectTypeOf<MatchConfigInput>().toEqualTypeOf<MatchConfig>();
    expectTypeOf<CreateEventInput>().toHaveProperty('sport');
  });

  it('action inputs always carry both guards', () => {
    expectTypeOf<z.infer<typeof matchActionInputSchema>>().toHaveProperty('txId');
    expectTypeOf<z.infer<typeof matchActionInputSchema>>().toHaveProperty('expectedVersion');
    expectTypeOf<z.infer<typeof matchActionInputSchema>>().toHaveProperty('type');
    expectTypeOf<z.infer<typeof matchActionInputSchema>>().toHaveProperty('payload');
  });

  it('domain types do not expose disabled or removed concepts', () => {
    expectTypeOf<MatchAction>().not.toHaveProperty('timeout');
    expectTypeOf<MatchConfig>().not.toHaveProperty('timeout');
    expectTypeOf<MatchContext>().not.toHaveProperty('tournamentId');
  });
});
