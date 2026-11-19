import { describe, expect, it } from 'vitest';
import {
  dateSchema,
  expectedVersionSchema,
  idSchema,
  matchStatusSchema,
  nonEmptyString,
  resultDecisionSchema,
  sportSchema,
  teamSideSchema,
  TEXT_LIMITS,
  txIdSchema,
} from './common.js';

describe('common schemas', () => {
  it('accepts only the four MVP sports', () => {
    for (const sport of ['basketball', 'futsal', 'badminton', 'volleyball']) {
      expect(sportSchema.safeParse(sport).success).toBe(true);
    }
    expect(sportSchema.safeParse('soccer').success).toBe(false);
    expect(sportSchema.safeParse('football').success).toBe(false);
  });

  it('accepts only home and away sides', () => {
    expect(teamSideSchema.safeParse('home').success).toBe(true);
    expect(teamSideSchema.safeParse('away').success).toBe(true);
    expect(teamSideSchema.safeParse('neutral').success).toBe(false);
  });

  it('mirrors the lifecycle axes', () => {
    for (const status of ['ready', 'live', 'finished', 'cancelled']) {
      expect(matchStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const decision of ['undecided', 'saved', 'discarded']) {
      expect(resultDecisionSchema.safeParse(decision).success).toBe(true);
    }
    expect(matchStatusSchema.safeParse('paused').success).toBe(false);
    expect(resultDecisionSchema.safeParse('approved').success).toBe(false);
  });

  it('trims and rejects blank strings', () => {
    const name = nonEmptyString(TEXT_LIMITS.teamName);

    expect(name.parse('  Lakers  ')).toBe('Lakers');
    expect(name.safeParse('').success).toBe(false);
    expect(name.safeParse('   ').success).toBe(false);
    expect(name.safeParse('a'.repeat(TEXT_LIMITS.teamName + 1)).success).toBe(false);
  });

  it('enforces the technical string limits', () => {
    expect(TEXT_LIMITS.teamName).toBe(80);
    expect(TEXT_LIMITS.eventName).toBe(120);
    expect(TEXT_LIMITS.correctionReason).toBe(500);
    expect(TEXT_LIMITS.txId).toBe(128);

    expect(idSchema.safeParse('x'.repeat(TEXT_LIMITS.matchId)).success).toBe(true);
    expect(idSchema.safeParse('x'.repeat(TEXT_LIMITS.matchId + 1)).success).toBe(false);
    expect(txIdSchema.safeParse('x'.repeat(TEXT_LIMITS.txId)).success).toBe(true);
    expect(txIdSchema.safeParse('x'.repeat(TEXT_LIMITS.txId + 1)).success).toBe(false);
  });

  it('requires a non-negative integer version', () => {
    expect(expectedVersionSchema.safeParse(0).success).toBe(true);
    expect(expectedVersionSchema.safeParse(42).success).toBe(true);
    expect(expectedVersionSchema.safeParse(-1).success).toBe(false);
    expect(expectedVersionSchema.safeParse(1.5).success).toBe(false);
    expect(expectedVersionSchema.safeParse('3').success).toBe(false);
  });

  it('coerces ISO date strings', () => {
    const parsed = dateSchema.parse('2026-11-14T00:00:00.000Z');

    expect(parsed).toBeInstanceOf(Date);
    expect(dateSchema.safeParse('not-a-date').success).toBe(false);
  });
});
