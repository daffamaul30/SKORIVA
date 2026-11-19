import { describe, expect, it } from 'vitest';
import { teamSchema, teamsSchema } from './team.js';

const home = { name: 'Garuda' };
const away = { name: 'Rajawali' };

describe('team schemas', () => {
  it('accepts a minimal team', () => {
    expect(teamSchema.parse({ name: 'Garuda' })).toEqual({ name: 'Garuda' });
  });

  it('accepts optional abbr and color', () => {
    const parsed = teamSchema.parse({ name: 'Garuda', abbr: 'GRD', color: '#ff0000' });

    expect(parsed.abbr).toBe('GRD');
    expect(parsed.color).toBe('#ff0000');
  });

  it('rejects a blank name', () => {
    expect(teamSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(teamSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(teamSchema.safeParse({ abbr: 'GRD' }).success).toBe(false);
  });

  it('rejects names over the limit (80)', () => {
    expect(teamSchema.safeParse({ name: 'a'.repeat(80) }).success).toBe(true);
    expect(teamSchema.safeParse({ name: 'a'.repeat(81) }).success).toBe(false);
  });

  it('rejects unknown team fields', () => {
    expect(teamSchema.safeParse({ name: 'Garuda', coach: 'X' }).success).toBe(false);
    expect(teamSchema.safeParse({ name: 'Garuda', players: [] }).success).toBe(false);
  });

  it('accepts two distinct teams', () => {
    expect(teamsSchema.safeParse({ home, away }).success).toBe(true);
  });

  it('rejects identical team names', () => {
    const result = teamsSchema.safeParse({ home, away: { name: 'Garuda' } });

    expect(result.success).toBe(false);
  });

  it('rejects identical team colors', () => {
    expect(
      teamsSchema.safeParse({
        home: { name: 'A', color: '#ff0000' },
        away: { name: 'B', color: '#ff0000' },
      }).success,
    ).toBe(false);
  });

  it('compares colors case-insensitively', () => {
    expect(
      teamsSchema.safeParse({
        home: { name: 'A', color: '#FF0000' },
        away: { name: 'B', color: '#ff0000' },
      }).success,
    ).toBe(false);
  });

  it('allows colors when only one side sets one', () => {
    expect(
      teamsSchema.safeParse({
        home: { name: 'A', color: '#ff0000' },
        away: { name: 'B' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    expect(teamsSchema.safeParse({ home, away, officials: [] }).success).toBe(false);
  });
});
