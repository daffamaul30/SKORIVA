import { describe, expect, it } from 'vitest';
import { OPERATIONAL_ACTION_TYPES } from '../domain/action.js';
import { matchActionInputSchema, matchActionSchema } from './action.js';

const envelope = { txId: 'tx-1', expectedVersion: 3 };

const validActions = [
  { type: 'score.change', payload: { side: 'home', points: 2 } },
  { type: 'clock.start', payload: {} },
  { type: 'clock.pause', payload: { remainingMs: 1000 } },
  { type: 'clock.resume', payload: { remainingMs: 1000 } },
  { type: 'clock.reset', payload: { remainingMs: 600000 } },
  { type: 'clock.confirm', payload: { remainingMs: 500 } },
  { type: 'period.next', payload: {} },
  { type: 'period.prev', payload: {} },
  { type: 'shotClock.reset', payload: {} },
  { type: 'possession.set', payload: { side: 'away' } },
  { type: 'foul.add', payload: { side: 'home' } },
  { type: 'card.add', payload: { side: 'away', card: 'yellow' } },
  { type: 'badminton.serve.change', payload: { side: 'home' } },
  { type: 'badminton.interval', payload: { action: 'start' } },
  { type: 'badminton.changeEnds', payload: {} },
  { type: 'match.undo', payload: { targetSeq: 12 } },
] as const;

describe('matchActionSchema', () => {
  it('covers every operational action type exactly once', () => {
    expect(validActions).toHaveLength(OPERATIONAL_ACTION_TYPES.length);
    expect(validActions.map((action) => action.type).sort()).toEqual(
      [...OPERATIONAL_ACTION_TYPES].sort(),
    );
  });

  it('accepts every declared action', () => {
    for (const action of validActions) {
      const result = matchActionSchema.safeParse(action);
      expect(result.success, `${action.type}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('rejects an action without its payload', () => {
    expect(matchActionSchema.safeParse({ type: 'period.next' }).success).toBe(false);
  });

  it('rejects a null payload', () => {
    expect(matchActionSchema.safeParse({ type: 'period.next', payload: null }).success).toBe(false);
  });

  it('rejects extra fields on an empty payload', () => {
    expect(
      matchActionSchema.safeParse({ type: 'period.next', payload: { extra: true } }).success,
    ).toBe(false);
  });

  it('rejects envelope fields inside the action body', () => {
    expect(
      matchActionSchema.safeParse({ type: 'period.next', payload: {}, txId: 't' }).success,
    ).toBe(false);
  });

  it('rejects an unknown action type', () => {
    expect(matchActionSchema.safeParse({ type: 'unknown.action', payload: {} }).success).toBe(
      false,
    );
  });

  it('has no disabled feature action (B-03)', () => {
    const forbiddenType = ['time', 'out'].join('');
    const result = matchActionSchema.safeParse({ type: forbiddenType, payload: {} });

    expect(result.success).toBe(false);
  });

  it('has no direct decrement action (FIX-04)', () => {
    const decrementType = ['score', 'decrement'].join('.');
    const result = matchActionSchema.safeParse({ type: decrementType, payload: { side: 'home' } });

    expect(result.success).toBe(false);
  });

  it('allows negative points at the generic schema level (volleyball decrement)', () => {
    // The sport engine decides whether this is legal; Badminton rejects it.
    expect(
      matchActionSchema.safeParse({ type: 'score.change', payload: { side: 'home', points: -1 } })
        .success,
    ).toBe(true);
  });

  it('rejects zero points and non-integer points', () => {
    expect(
      matchActionSchema.safeParse({ type: 'score.change', payload: { side: 'home', points: 0 } })
        .success,
    ).toBe(false);
    expect(
      matchActionSchema.safeParse({ type: 'score.change', payload: { side: 'home', points: 1.5 } })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid side, card, or interval action', () => {
    expect(
      matchActionSchema.safeParse({ type: 'score.change', payload: { side: 'neutral', points: 1 } })
        .success,
    ).toBe(false);
    expect(
      matchActionSchema.safeParse({
        type: 'card.add',
        payload: { side: 'home', card: 'blue' },
      }).success,
    ).toBe(false);
    expect(
      matchActionSchema.safeParse({
        type: 'badminton.interval',
        payload: { action: 'pause' },
      }).success,
    ).toBe(false);
  });

  it('rejects non-positive undo targets and negative clock values', () => {
    expect(
      matchActionSchema.safeParse({ type: 'match.undo', payload: { targetSeq: 0 } }).success,
    ).toBe(false);
    expect(
      matchActionSchema.safeParse({ type: 'clock.start', payload: { remainingMs: -1 } }).success,
    ).toBe(false);
  });

  it('rejects unknown payload fields', () => {
    expect(
      matchActionSchema.safeParse({
        type: 'badminton.serve.change',
        payload: { side: 'home', court: 'left' },
      }).success,
    ).toBe(false);
  });
});

describe('matchActionInputSchema', () => {
  it('accepts every action with txId and expectedVersion', () => {
    for (const action of validActions) {
      const result = matchActionInputSchema.safeParse({ ...envelope, ...action });
      expect(result.success, `${action.type}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('requires txId', () => {
    expect(
      matchActionInputSchema.safeParse({ expectedVersion: 0, ...validActions[0] }).success,
    ).toBe(false);
  });

  it('requires expectedVersion', () => {
    expect(matchActionInputSchema.safeParse({ txId: 't', ...validActions[0] }).success).toBe(false);
  });

  it('requires type and payload', () => {
    expect(matchActionInputSchema.safeParse(envelope).success).toBe(false);
  });

  it('rejects a blank txId', () => {
    expect(
      matchActionInputSchema.safeParse({ ...envelope, txId: '  ', ...validActions[0] }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      matchActionInputSchema.safeParse({ ...envelope, ...validActions[0], matchId: 'm' }).success,
    ).toBe(false);
  });

  it('rejects the disabled action and direct decrement through the envelope', () => {
    const forbiddenType = ['time', 'out'].join('');
    const decrementType = ['score', 'decrement'].join('.');

    expect(
      matchActionInputSchema.safeParse({ ...envelope, type: forbiddenType, payload: {} }).success,
    ).toBe(false);
    expect(
      matchActionInputSchema.safeParse({
        ...envelope,
        type: decrementType,
        payload: { side: 'home' },
      }).success,
    ).toBe(false);
  });
});
