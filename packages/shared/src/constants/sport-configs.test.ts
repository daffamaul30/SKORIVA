import { describe, expect, it } from 'vitest';
import { SPORTS } from '../domain/sport.js';
import { BASKETBALL_DEFAULTS } from './basketball.js';
import { BADMINTON_DEFAULTS } from './badminton.js';
import { FUTSAL_DEFAULTS } from './futsal.js';
import { getDefaultSportConfig, SPORT_DEFAULTS } from './sport-configs.js';
import { VOLLEYBALL_DEFAULTS } from './volleyball.js';

describe('getDefaultSportConfig', () => {
  it('returns the basketball defaults', () => {
    const config = getDefaultSportConfig('basketball');

    expect(config.periods.count).toBe(4);
    expect(config.periods.durationMs).toBe(10 * 60 * 1000);
    expect(config.periods.labels).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(config.gameClock).toEqual({ mode: 'timed', allowStop: true });
    expect(config.shotClock).toEqual({ enabled: true, durationMs: 24 * 1000 });
    expect(config.scoring.pointsPerGoal).toEqual([1, 2, 3]);
  });

  it('returns the futsal defaults', () => {
    const config = getDefaultSportConfig('futsal');

    expect(config.periods.count).toBe(2);
    expect(config.periods.durationMs).toBe(20 * 60 * 1000);
    expect(config.gameClock.mode).toBe('timed');
    expect(config.shotClock.enabled).toBe(false);
    expect(config.scoring.pointsPerGoal).toEqual([1]);
  });

  it('returns the badminton defaults', () => {
    const config = getDefaultSportConfig('badminton');

    expect(config.gameClock.mode).toBe('none');
    expect(config.shotClock.enabled).toBe(false);
    expect(config.badminton).toBeDefined();
    expect(config.badminton?.bestOf).toBe(3);
    expect(config.badminton?.pointTarget).toBe(21);
    expect(config.badminton?.winByDiff).toBe(2);
    expect(config.badminton?.pointCap).toBe(30);
  });

  it('returns the volleyball defaults', () => {
    const config = getDefaultSportConfig('volleyball');

    expect(config.gameClock.mode).toBe('none');
    expect(config.shotClock.enabled).toBe(false);
    expect(config.volleyball).toEqual({
      bestOf: 3,
      pointTarget: 25,
      tiebreakTarget: 15,
      winByDiff: 2,
    });
  });

  it('covers every MVP sport in SPORTS', () => {
    for (const sport of SPORTS) {
      expect(getDefaultSportConfig(sport)).toBeDefined();
      expect(SPORT_DEFAULTS[sport]).toBeDefined();
    }

    expect(SPORTS).toHaveLength(4);
  });

  it('returns a fresh copy that cannot mutate the shared defaults', () => {
    const first = getDefaultSportConfig('basketball');
    first.periods.count = 99;
    first.scoring.pointsPerGoal.push(99);

    const second = getDefaultSportConfig('basketball');
    expect(second.periods.count).toBe(BASKETBALL_DEFAULTS.periods.count);
    expect(second.scoring.pointsPerGoal).toEqual(BASKETBALL_DEFAULTS.scoring.pointsPerGoal);
  });

  it('does not require a duration value for a clock-less sport', () => {
    // `mode: 'none'` is a distinct variant: no `allowStop`, and the period
    // duration is not a meaningful clock setting for these sports.
    expect(getDefaultSportConfig('volleyball').gameClock).toStrictEqual({ mode: 'none' });
    expect(getDefaultSportConfig('badminton').gameClock).toStrictEqual({ mode: 'none' });

    expect(BADMINTON_DEFAULTS.badminton).toBeDefined();
    expect(FUTSAL_DEFAULTS.shotClock.enabled).toBe(false);
    expect(VOLLEYBALL_DEFAULTS.volleyball.bestOf).toBe(3);
  });
});
