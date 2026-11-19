import { describe, expect, it } from 'vitest';
import {
  finalScoreCorrectionSchema,
  resultCorrectionSchema,
  setsAndPointsCorrectionSchema,
} from './correction.js';

describe('final score correction (basketball/futsal)', () => {
  it('accepts homeScore and awayScore', () => {
    expect(finalScoreCorrectionSchema.parse({ homeScore: 88, awayScore: 84 })).toEqual({
      homeScore: 88,
      awayScore: 84,
    });
  });

  it('accepts zero', () => {
    expect(finalScoreCorrectionSchema.safeParse({ homeScore: 0, awayScore: 0 }).success).toBe(true);
  });

  it('rejects negative, fractional, or unknown fields', () => {
    expect(finalScoreCorrectionSchema.safeParse({ homeScore: -1, awayScore: 0 }).success).toBe(
      false,
    );
    expect(finalScoreCorrectionSchema.safeParse({ homeScore: 1.5, awayScore: 0 }).success).toBe(
      false,
    );
    expect(
      finalScoreCorrectionSchema.safeParse({ homeScore: 1, awayScore: 0, overtime: 0 }).success,
    ).toBe(false);
  });

  it('rejects the previous discriminated shape', () => {
    expect(
      finalScoreCorrectionSchema.safeParse({
        sport: 'basketball',
        after: { home: 1, away: 2 },
      }).success,
    ).toBe(false);
  });
});

describe('sets and points correction (volleyball/badminton)', () => {
  const valid = {
    sets: [
      { home: 21, away: 19, winner: 'home' },
      { home: 15, away: 21, winner: 'away' },
      { home: 18, away: 12 },
    ],
    points: { home: 18, away: 12 },
  };

  it('accepts sets and points', () => {
    expect(setsAndPointsCorrectionSchema.parse(valid)).toEqual(valid);
  });

  it('accepts sets without a winner', () => {
    expect(
      setsAndPointsCorrectionSchema.safeParse({
        sets: [{ home: 5, away: 3 }],
        points: { home: 5, away: 3 },
      }).success,
    ).toBe(true);
  });

  it('requires at least one set', () => {
    expect(
      setsAndPointsCorrectionSchema.safeParse({ sets: [], points: { home: 0, away: 0 } }).success,
    ).toBe(false);
  });

  it('rejects an invalid winner side', () => {
    expect(
      setsAndPointsCorrectionSchema.safeParse({
        sets: [{ home: 1, away: 0, winner: 'both' }],
        points: { home: 1, away: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(setsAndPointsCorrectionSchema.safeParse({ ...valid, bestOf: 3 }).success).toBe(false);
  });
});

describe('result correction union', () => {
  it('accepts either shape', () => {
    expect(resultCorrectionSchema.safeParse({ homeScore: 1, awayScore: 2 }).success).toBe(true);
    expect(
      resultCorrectionSchema.safeParse({
        sets: [{ home: 1, away: 0 }],
        points: { home: 1, away: 0 },
      }).success,
    ).toBe(true);
  });

  it('rejects anything else', () => {
    expect(resultCorrectionSchema.safeParse({ score: 1 }).success).toBe(false);
    expect(resultCorrectionSchema.safeParse(null).success).toBe(false);
  });
});
