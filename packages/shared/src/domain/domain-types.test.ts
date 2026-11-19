import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EventDocument,
  FinalScoreCorrection,
  GameClockConfig,
  MatchAction,
  MatchAggregate,
  MatchEventRecord,
  MatchState,
  ResultCorrection,
  SetsAndPointsCorrection,
  SportConfigFor,
  SportEngine,
  SportState,
} from './index.js';
import { EVENT_TYPES, MATCH_STATUSES, RESULT_DECISIONS, SPORTS } from './index.js';

describe('domain types', () => {
  it('lists the four MVP sports', () => {
    expect(SPORTS).toEqual(['basketball', 'futsal', 'badminton', 'volleyball']);
  });

  it('defines the lifecycle axes from Tech Spec §1.4', () => {
    expect(MATCH_STATUSES).toEqual(['ready', 'live', 'finished', 'cancelled']);
    expect(RESULT_DECISIONS).toEqual(['undecided', 'saved', 'discarded']);
  });

  it('keeps every event type from Tech Spec §4.4 and nothing else', () => {
    expect(EVENT_TYPES).toContain('clock.confirm');
    expect(EVENT_TYPES).toContain('period.prev');
    expect(EVENT_TYPES).toContain('badminton.serve.change');
    expect(EVENT_TYPES).toContain('operator.handover');
    // Duplicates would indicate a copy/paste error in the union.
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('exposes a read-only aggregate without player or roster fields', () => {
    expectTypeOf<MatchAggregate>().not.toHaveProperty('players');
    expectTypeOf<MatchAggregate>().not.toHaveProperty('roster');
    expectTypeOf<MatchAggregate>().not.toHaveProperty('tournamentId');
    expectTypeOf<EventDocument>().not.toHaveProperty('bracket');
  });

  it('marks period.prev as an operational action and keeps the envelope guards', () => {
    expectTypeOf<MatchAction>().extract<{ type: 'period.prev' }>().toHaveProperty('payload');

    expectTypeOf<MatchEventRecord>().toHaveProperty('txId');
    expectTypeOf<MatchState>().toHaveProperty('version');
  });

  it('describes the sport engine contract without a runtime implementation', () => {
    expectTypeOf<SportEngine<'basketball'>>().toHaveProperty('supportsStepBackPeriod');
    expectTypeOf<SportEngine<'volleyball'>>().toHaveProperty('canStepBackPeriod');
    expectTypeOf<SportState>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
  });

  it('allows futsal to run with or without a game clock (PRD FR-03)', () => {
    expectTypeOf<SportConfigFor<'futsal'>['gameClock']>().toEqualTypeOf<GameClockConfig>();
    expectTypeOf<SportConfigFor<'basketball'>['gameClock']>().toEqualTypeOf<
      Extract<GameClockConfig, { mode: 'timed' }>
    >();
    expectTypeOf<SportConfigFor<'volleyball'>['gameClock']>().toEqualTypeOf<{ mode: 'none' }>();
  });

  it('keeps the tech-spec correction shapes (B-10)', () => {
    expectTypeOf<FinalScoreCorrection>().toEqualTypeOf<{ homeScore: number; awayScore: number }>();
    expectTypeOf<ResultCorrection>().not.toHaveProperty('after');
    expectTypeOf<SetsAndPointsCorrection>().toHaveProperty('points');
  });
});
