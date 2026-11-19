import { describe, expect, it } from 'vitest';
import { BADMINTON_DEFAULTS, BADMINTON_RULES_BASELINE } from './badminton.js';

describe('badminton defaults (BWF, PRD B-02)', () => {
  it('uses best of 3 sets', () => {
    expect(BADMINTON_DEFAULTS.badminton.bestOf).toBe(3);
    expect(BADMINTON_DEFAULTS.periods.count).toBe(3);
  });

  it('plays sets to 21 with a 2-point margin and a 30-point cap', () => {
    expect(BADMINTON_DEFAULTS.badminton.pointTarget).toBe(21);
    expect(BADMINTON_DEFAULTS.badminton.winByDiff).toBe(2);
    expect(BADMINTON_DEFAULTS.badminton.pointCap).toBe(30);
  });

  it('takes the interval at 11 points and changes ends at 11 in the deciding set', () => {
    expect(BADMINTON_DEFAULTS.badminton.intervalAt).toBe(11);
    expect(BADMINTON_DEFAULTS.badminton.intervalDurationMs).toBe(60 * 1000);
    expect(BADMINTON_DEFAULTS.badminton.changeEndsAtDecidingSet).toBe(11);
  });

  it('has no game clock and no shot clock', () => {
    expect(BADMINTON_DEFAULTS.gameClock).toStrictEqual({ mode: 'none' });
    expect(BADMINTON_DEFAULTS.shotClock.enabled).toBe(false);
  });

  it('records the R-05 regulatory baseline', () => {
    expect(BADMINTON_RULES_BASELINE.document).toBe('BWF Laws of Badminton');
    expect(BADMINTON_RULES_BASELINE.version).toBe('26 April 2025, Version 5.0');
    expect(BADMINTON_RULES_BASELINE.source).toBe('https://corporate.bwfbadminton.com/statutes/');
    expect(BADMINTON_RULES_BASELINE.verifiedAt).toBe('2026-11-13');
  });
});
