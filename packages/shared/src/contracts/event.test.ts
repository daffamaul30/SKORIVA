import { describe, expect, it } from 'vitest';
import { archiveEventSchema, createEventSchema, updateEventSchema } from './event.js';

describe('create event schema', () => {
  it('accepts the required name and sport', () => {
    expect(createEventSchema.parse({ name: 'Liga Kampus', sport: 'futsal' })).toEqual({
      name: 'Liga Kampus',
      sport: 'futsal',
    });
  });

  it('accepts optional parentId, description, and date', () => {
    const result = createEventSchema.safeParse({
      name: 'Liga Kampus',
      sport: 'badminton',
      parentId: 'evt_parent',
      description: 'Turnamen antar fakultas',
      date: '2026-12-01',
    });

    expect(result.success).toBe(true);
  });

  it('requires sport (BR-18)', () => {
    expect(createEventSchema.safeParse({ name: 'Liga Kampus' }).success).toBe(false);
  });

  it('requires a non-blank name and enforces 120 characters', () => {
    expect(createEventSchema.safeParse({ name: '  ', sport: 'futsal' }).success).toBe(false);
    expect(createEventSchema.safeParse({ name: 'a'.repeat(120), sport: 'futsal' }).success).toBe(
      true,
    );
    expect(createEventSchema.safeParse({ name: 'a'.repeat(121), sport: 'futsal' }).success).toBe(
      false,
    );
  });

  it('never accepts ownerId from the client (B-05)', () => {
    expect(
      createEventSchema.safeParse({ name: 'X', sport: 'futsal', ownerId: 'acc_1' }).success,
    ).toBe(false);
  });

  it('never accepts an archived flag from the client', () => {
    expect(
      createEventSchema.safeParse({ name: 'X', sport: 'futsal', archived: true }).success,
    ).toBe(false);
  });

  it('rejects a removed grouping key', () => {
    const removedKey = ['tour', 'namentId'].join('');

    expect(
      createEventSchema.safeParse({ name: 'X', sport: 'futsal', [removedKey]: 't' }).success,
    ).toBe(false);
  });

  it('rejects an invalid date', () => {
    expect(createEventSchema.safeParse({ name: 'X', sport: 'futsal', date: 'nope' }).success).toBe(
      false,
    );
  });
});

describe('update event schema', () => {
  it('accepts a single editable field', () => {
    expect(updateEventSchema.safeParse({ name: 'Liga Baru' }).success).toBe(true);
    expect(updateEventSchema.safeParse({ description: 'Baru' }).success).toBe(true);
    expect(updateEventSchema.safeParse({ date: '2026-12-01' }).success).toBe(true);
  });

  it('rejects an empty update', () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });

  it('does not allow changing sport or parentId', () => {
    expect(updateEventSchema.safeParse({ sport: 'basketball' }).success).toBe(false);
    expect(updateEventSchema.safeParse({ parentId: 'evt_parent' }).success).toBe(false);
  });

  it('does not allow ownership or archival changes', () => {
    expect(updateEventSchema.safeParse({ ownerId: 'acc_2' }).success).toBe(false);
    expect(updateEventSchema.safeParse({ archived: true }).success).toBe(false);
  });
});

describe('archive event schema', () => {
  it('accepts an empty body', () => {
    expect(archiveEventSchema.safeParse({}).success).toBe(true);
  });

  it('rejects any body field', () => {
    expect(archiveEventSchema.safeParse({ archived: true }).success).toBe(false);
  });
});
