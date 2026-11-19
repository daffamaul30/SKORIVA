import { describe, expect, it } from 'vitest';
import {
  correctResultSchema,
  correctResultSchemaForSport,
  lifecycleActionSchema,
} from './lifecycle.js';

const setsCorrection = {
  sets: [
    { home: 21, away: 19, winner: 'home' },
    { home: 21, away: 15, winner: 'home' },
  ],
  points: { home: 0, away: 0 },
};

describe('lifecycle action schema', () => {
  it('accepts txId and expectedVersion', () => {
    expect(lifecycleActionSchema.parse({ txId: 'tx-1', expectedVersion: 0 })).toEqual({
      txId: 'tx-1',
      expectedVersion: 0,
    });
  });

  it('requires both guards', () => {
    expect(lifecycleActionSchema.safeParse({ txId: 'tx-1' }).success).toBe(false);
    expect(lifecycleActionSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  it('rejects a negative or fractional version', () => {
    expect(lifecycleActionSchema.safeParse({ txId: 't', expectedVersion: -1 }).success).toBe(false);
    expect(lifecycleActionSchema.safeParse({ txId: 't', expectedVersion: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects a blank txId and one over the limit', () => {
    expect(lifecycleActionSchema.safeParse({ txId: '  ', expectedVersion: 0 }).success).toBe(false);
    expect(
      lifecycleActionSchema.safeParse({ txId: 'x'.repeat(129), expectedVersion: 0 }).success,
    ).toBe(false);
  });

  it('rejects transport-specific fields in the body (session proof is a header)', () => {
    expect(
      lifecycleActionSchema.safeParse({
        txId: 't',
        expectedVersion: 0,
        operatorSession: 'secret',
      }).success,
    ).toBe(false);
  });
});

describe('correct result schema', () => {
  it('accepts a basketball/futsal final-score correction', () => {
    const result = correctResultSchema.safeParse({
      txId: 'tx-1',
      expectedVersion: 10,
      reason: 'Salah input skor akhir.',
      correction: { homeScore: 88, awayScore: 84 },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a volleyball/badminton sets-and-points correction', () => {
    const result = correctResultSchema.safeParse({
      txId: 'tx-1',
      expectedVersion: 10,
      reason: 'Set kedua seharusnya 21-15.',
      correction: setsCorrection,
    });

    expect(result.success).toBe(true);
  });

  it('requires a non-empty reason (B-10)', () => {
    expect(
      correctResultSchema.safeParse({
        txId: 't',
        expectedVersion: 1,
        reason: '   ',
        correction: { homeScore: 1, awayScore: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects a reason over 500 characters', () => {
    expect(
      correctResultSchema.safeParse({
        txId: 't',
        expectedVersion: 1,
        reason: 'a'.repeat(501),
        correction: { homeScore: 1, awayScore: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects a correction without sets or score', () => {
    expect(
      correctResultSchema.safeParse({
        txId: 't',
        expectedVersion: 1,
        reason: 'x',
        correction: {},
      }).success,
    ).toBe(false);
  });

  it('rejects negative scores', () => {
    expect(
      correctResultSchema.safeParse({
        txId: 't',
        expectedVersion: 1,
        reason: 'x',
        correction: { homeScore: -1, awayScore: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects the old T-02 shape with sport/after/currentPoints', () => {
    expect(
      correctResultSchema.safeParse({
        txId: 't',
        expectedVersion: 1,
        reason: 'x',
        correction: {
          sport: 'badminton',
          after: { sets: [], currentPoints: { home: 0, away: 0 } },
        },
      }).success,
    ).toBe(false);
  });
});

describe('correctResultSchemaForSport', () => {
  const base = { txId: 't', expectedVersion: 1, reason: 'koreksi' };

  it('requires a final score for basketball and futsal', () => {
    for (const sport of ['basketball', 'futsal'] as const) {
      expect(
        correctResultSchemaForSport(sport).safeParse({
          ...base,
          correction: { homeScore: 10, awayScore: 8 },
        }).success,
      ).toBe(true);

      expect(
        correctResultSchemaForSport(sport).safeParse({ ...base, correction: setsCorrection })
          .success,
      ).toBe(false);
    }
  });

  it('requires sets and points for volleyball and badminton', () => {
    for (const sport of ['volleyball', 'badminton'] as const) {
      expect(
        correctResultSchemaForSport(sport).safeParse({ ...base, correction: setsCorrection })
          .success,
      ).toBe(true);

      expect(
        correctResultSchemaForSport(sport).safeParse({
          ...base,
          correction: { homeScore: 10, awayScore: 8 },
        }).success,
      ).toBe(false);
    }
  });

  it('still requires the reason', () => {
    expect(
      correctResultSchemaForSport('basketball').safeParse({
        txId: 't',
        expectedVersion: 1,
        correction: { homeScore: 1, awayScore: 1 },
      }).success,
    ).toBe(false);
  });
});
