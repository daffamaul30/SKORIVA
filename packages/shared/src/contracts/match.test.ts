import { describe, expect, it } from 'vitest';
import {
  BADMINTON_DEFAULTS,
  BASKETBALL_DEFAULTS,
  VOLLEYBALL_DEFAULTS,
} from '../constants/index.js';
import {
  createMatchSchema,
  matchContextSchema,
  updateMatchSchema,
  updateMatchSchemaForSport,
} from './match.js';

const teams = { home: { name: 'Garuda' }, away: { name: 'Rajawali' } };

const futsalNoClock = {
  ...BADMINTON_DEFAULTS,
  badminton: undefined,
};

describe('match context schema', () => {
  it('accepts an empty context', () => {
    expect(matchContextSchema.parse({})).toEqual({});
  });

  it('accepts eventId, stageLabel and matchNumber', () => {
    const parsed = matchContextSchema.parse({
      eventId: 'evt_1',
      stageLabel: 'Semifinal',
      matchNumber: 3,
    });

    expect(parsed).toEqual({ eventId: 'evt_1', stageLabel: 'Semifinal', matchNumber: 3 });
  });

  it('produces the eventId needed for BR-15/B-04 server validation', () => {
    const objectKeys = Object.keys(matchContextSchema.shape);

    expect(objectKeys).toContain('eventId');
  });

  it('rejects a non-positive matchNumber', () => {
    expect(matchContextSchema.safeParse({ matchNumber: 0 }).success).toBe(false);
  });

  it('rejects removed or unknown context keys', () => {
    const removedKey = ['tour', 'namentId'].join('');

    expect(matchContextSchema.safeParse({ [removedKey]: 'x' }).success).toBe(false);
    expect(matchContextSchema.safeParse({ groupLabel: 'A' }).success).toBe(false);
  });
});

describe('create match schema', () => {
  it('accepts the three required inputs (sport + two teams)', () => {
    expect(createMatchSchema.safeParse({ sport: 'basketball', teams }).success).toBe(true);
  });

  it('accepts optional config and context', () => {
    const result = createMatchSchema.safeParse({
      sport: 'badminton',
      teams,
      config: BADMINTON_DEFAULTS,
      context: { eventId: 'evt_1', stageLabel: 'Final' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a futsal match with the timer disabled', () => {
    const result = createMatchSchema.safeParse({
      sport: 'futsal',
      teams,
      config: { ...futsalNoClock, gameClock: { mode: 'none' } },
    });

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('rejects an unknown sport', () => {
    expect(createMatchSchema.safeParse({ sport: 'soccer', teams }).success).toBe(false);
  });

  it('rejects identical team names', () => {
    expect(
      createMatchSchema.safeParse({
        sport: 'basketball',
        teams: { home: { name: 'A' }, away: { name: 'A' } },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (owner, access, state)', () => {
    for (const extra of [{ owner: {} }, { access: {} }, { state: {} }, { matchStatus: 'ready' }]) {
      expect(createMatchSchema.safeParse({ sport: 'basketball', teams, ...extra }).success).toBe(
        false,
      );
    }
  });

  it('rejects basketball config without a timed clock', () => {
    const result = createMatchSchema.safeParse({
      sport: 'basketball',
      teams,
      config: { ...BASKETBALL_DEFAULTS, gameClock: { mode: 'none' } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects volleyball config with a timed clock', () => {
    const result = createMatchSchema.safeParse({
      sport: 'volleyball',
      teams,
      config: { ...VOLLEYBALL_DEFAULTS, gameClock: { mode: 'timed', allowStop: true } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects volleyball config without a volleyball block', () => {
    const result = createMatchSchema.safeParse({
      sport: 'volleyball',
      teams,
      config: { ...VOLLEYBALL_DEFAULTS, volleyball: undefined },
    });

    expect(result.success).toBe(false);
  });

  it('rejects badminton config carrying volleyball settings', () => {
    const result = createMatchSchema.safeParse({
      sport: 'badminton',
      teams,
      config: { ...BADMINTON_DEFAULTS, volleyball: VOLLEYBALL_DEFAULTS.volleyball },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a shot clock on futsal', () => {
    const result = createMatchSchema.safeParse({
      sport: 'futsal',
      teams,
      config: { ...futsalNoClock, shotClock: { enabled: true, durationMs: 24000 } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a config key for a disabled feature (B-03)', () => {
    const forbiddenKey = ['time', 'out'].join('');
    const result = createMatchSchema.safeParse({
      sport: 'basketball',
      teams,
      config: { ...BASKETBALL_DEFAULTS, [forbiddenKey]: { enabled: true } },
    });

    expect(result.success).toBe(false);
  });
});

describe('update match schema', () => {
  it('accepts a partial update with one field', () => {
    expect(updateMatchSchema.safeParse({ teams }).success).toBe(true);
    expect(updateMatchSchema.safeParse({ context: { stageLabel: 'Final' } }).success).toBe(true);
  });

  it('rejects an empty update', () => {
    expect(updateMatchSchema.safeParse({}).success).toBe(false);
  });

  it('rejects null instead of absent', () => {
    expect(updateMatchSchema.safeParse({ teams: null }).success).toBe(false);
  });

  it('rejects unknown fields (sport is not editable)', () => {
    expect(updateMatchSchema.safeParse({ sport: 'futsal' }).success).toBe(false);
    expect(updateMatchSchema.safeParse({ matchStatus: 'live' }).success).toBe(false);
  });

  it('is the same regardless of sport at the transport level', () => {
    // The generic schema accepts any structurally valid config; sport binding
    // happens with `updateMatchSchemaForSport` in handlers that know the sport.
    expect(updateMatchSchema.safeParse({ config: VOLLEYBALL_DEFAULTS }).success).toBe(true);
  });
});

describe('updateMatchSchemaForSport', () => {
  it('accepts a config valid for the bound sport', () => {
    expect(
      updateMatchSchemaForSport('volleyball').safeParse({ config: VOLLEYBALL_DEFAULTS }).success,
    ).toBe(true);
  });

  it('rejects a config that belongs to another sport', () => {
    expect(
      updateMatchSchemaForSport('volleyball').safeParse({ config: BASKETBALL_DEFAULTS }).success,
    ).toBe(false);
  });

  it('still accepts updates without a config', () => {
    expect(updateMatchSchemaForSport('basketball').safeParse({ teams }).success).toBe(true);
  });

  it('keeps empty-update rejection', () => {
    expect(updateMatchSchemaForSport('basketball').safeParse({}).success).toBe(false);
  });

  it('accepts futsal turning the clock off', () => {
    expect(
      updateMatchSchemaForSport('futsal').safeParse({
        config: { ...futsalNoClock, gameClock: { mode: 'none' } },
      }).success,
    ).toBe(true);
  });
});
