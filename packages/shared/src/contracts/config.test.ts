import { describe, expect, it } from 'vitest';
import {
  BADMINTON_DEFAULTS,
  BASKETBALL_DEFAULTS,
  FUTSAL_DEFAULTS,
  VOLLEYBALL_DEFAULTS,
} from '../constants/index.js';
import {
  badmintonConfigSchema,
  gameClockSchema,
  matchConfigSchema,
  periodConfigSchema,
  scoringSchema,
  shotClockSchema,
  volleyballConfigSchema,
} from './config.js';

describe('period config schema', () => {
  it('accepts a valid period config', () => {
    expect(periodConfigSchema.safeParse({ count: 4, durationMs: 600000 }).success).toBe(true);
  });

  it('rejects non-positive counts and negative durations', () => {
    expect(periodConfigSchema.safeParse({ count: 0, durationMs: 600000 }).success).toBe(false);
    expect(periodConfigSchema.safeParse({ count: 4, durationMs: -1 }).success).toBe(false);
  });
});

describe('game clock schema', () => {
  it('accepts timed with allowStop', () => {
    expect(gameClockSchema.parse({ mode: 'timed', allowStop: true })).toEqual({
      mode: 'timed',
      allowStop: true,
    });
  });

  it('accepts none without any duration field', () => {
    expect(gameClockSchema.parse({ mode: 'none' })).toEqual({ mode: 'none' });
  });

  it('rejects duration placeholders on a clock-less mode', () => {
    expect(gameClockSchema.safeParse({ mode: 'none', durationMs: 0 }).success).toBe(false);
    expect(gameClockSchema.safeParse({ mode: 'none', allowStop: false }).success).toBe(false);
  });

  it('rejects timed without allowStop', () => {
    expect(gameClockSchema.safeParse({ mode: 'timed' }).success).toBe(false);
  });
});

describe('shot clock schema', () => {
  const on = shotClockSchema.parse({ enabled: true, durationMs: 24000 });
  const off = shotClockSchema.parse({ enabled: false });

  it('accepts enabled without a duration', () => {
    expect(off).toEqual({ enabled: false });
  });

  it('accepts enabled:true with a positive duration', () => {
    expect(on).toEqual({ enabled: true, durationMs: 24000 });
  });

  it('rejects a duration on a disabled shot clock', () => {
    expect(shotClockSchema.safeParse({ enabled: false, durationMs: 24000 }).success).toBe(false);
  });

  it('rejects enabled:true without duration', () => {
    expect(shotClockSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});

describe('scoring schema', () => {
  it('accepts positive point values', () => {
    expect(scoringSchema.safeParse({ pointsPerGoal: [1, 2, 3] }).success).toBe(true);
  });

  it('rejects empty or non-positive point values', () => {
    expect(scoringSchema.safeParse({ pointsPerGoal: [] }).success).toBe(false);
    expect(scoringSchema.safeParse({ pointsPerGoal: [0] }).success).toBe(false);
    expect(scoringSchema.safeParse({ pointsPerGoal: [1.5] }).success).toBe(false);
  });
});

describe('volleyball config schema', () => {
  it('accepts best-of-3 or best-of-5', () => {
    expect(volleyballConfigSchema.safeParse(VOLLEYBALL_DEFAULTS.volleyball).success).toBe(true);
    expect(
      volleyballConfigSchema.safeParse({
        bestOf: 5,
        pointTarget: 25,
        tiebreakTarget: 15,
        winByDiff: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects an unsupported best-of value', () => {
    expect(
      volleyballConfigSchema.safeParse({
        bestOf: 4,
        pointTarget: 25,
        tiebreakTarget: 15,
        winByDiff: 2,
      }).success,
    ).toBe(false);
  });
});

describe('badminton config schema', () => {
  it('accepts the BWF defaults', () => {
    expect(badmintonConfigSchema.parse(BADMINTON_DEFAULTS.badminton)).toEqual(
      BADMINTON_DEFAULTS.badminton,
    );
  });

  it('rejects best-of other than 3', () => {
    expect(
      badmintonConfigSchema.safeParse({ ...BADMINTON_DEFAULTS.badminton, bestOf: 5 }).success,
    ).toBe(false);
  });

  it('rejects a non-positive point cap', () => {
    expect(
      badmintonConfigSchema.safeParse({ ...BADMINTON_DEFAULTS.badminton, pointCap: 0 }).success,
    ).toBe(false);
  });
});

describe('match config schema', () => {
  it('accepts every sport default', () => {
    for (const defaults of [
      BASKETBALL_DEFAULTS,
      FUTSAL_DEFAULTS,
      BADMINTON_DEFAULTS,
      VOLLEYBALL_DEFAULTS,
    ]) {
      const result = matchConfigSchema.safeParse(defaults);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it('rejects an unknown config key', () => {
    const config = { ...BASKETBALL_DEFAULTS, advanced: {} };

    expect(matchConfigSchema.safeParse(config).success).toBe(false);
  });

  it('does not declare any disabled feature (B-03)', () => {
    // The forbidden key is assembled at runtime so this test cannot match itself.
    const forbiddenKey = ['time', 'out'].join('');
    const topLevelKeys = Object.keys(matchConfigSchema.shape);

    expect(topLevelKeys).not.toContain(forbiddenKey);
  });
});
