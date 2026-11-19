import { describe, expect, it } from 'vitest';
import { SPORTS } from '../domain/sport.js';
import { getDefaultSportConfig } from './sport-configs.js';

/**
 * Guardrails for MVP configuration rules (B-03, B-01, BR-21).
 *
 * Timeout is checked structurally: the key name is assembled at runtime so that
 * this test file never contains the literal key it is searching for and cannot
 * produce a false positive against its own source.
 *
 * Note: the repository-wide source scan that also protects against this file is
 * performed in `no-forbidden-terms.test.ts`.
 */
const FORBIDDEN_TIMEOUT_KEY = ['time', 'out'].join('');

describe('default sport configuration guards', () => {
  it('contains no timeout configuration (B-03)', () => {
    for (const sport of SPORTS) {
      const serialised = JSON.stringify(getDefaultSportConfig(sport));
      expect(serialised.toLowerCase()).not.toContain(FORBIDDEN_TIMEOUT_KEY);
    }
  });

  it('never enables a game clock for volleyball or badminton', () => {
    expect(getDefaultSportConfig('volleyball').gameClock.mode).toBe('none');
    expect(getDefaultSportConfig('badminton').gameClock.mode).toBe('none');
  });

  it('enables a game clock only for basketball and futsal', () => {
    expect(getDefaultSportConfig('basketball').gameClock.mode).toBe('timed');
    expect(getDefaultSportConfig('futsal').gameClock.mode).toBe('timed');
  });

  it('enables the shot clock only for basketball', () => {
    expect(getDefaultSportConfig('basketball').shotClock.enabled).toBe(true);

    for (const sport of ['futsal', 'badminton', 'volleyball'] as const) {
      expect(getDefaultSportConfig(sport).shotClock.enabled).toBe(false);
    }
  });

  it('does not attach a disabled shot clock duration', () => {
    for (const sport of SPORTS) {
      const shotClock = getDefaultSportConfig(sport).shotClock;
      if (!shotClock.enabled) {
        expect(shotClock).toStrictEqual({ enabled: false });
        expect(Object.keys(shotClock)).toEqual(['enabled']);
      }
    }
  });

  it('does not attach extra fields to a clock-less game clock', () => {
    for (const sport of ['volleyball', 'badminton'] as const) {
      const gameClock = getDefaultSportConfig(sport).gameClock;
      expect(gameClock).toStrictEqual({ mode: 'none' });
      expect(Object.keys(gameClock)).toEqual(['mode']);
    }
  });

  it('attaches sport-specific config only to its own sport', () => {
    expect(getDefaultSportConfig('basketball')).not.toHaveProperty('volleyball');
    expect(getDefaultSportConfig('basketball')).not.toHaveProperty('badminton');
    expect(getDefaultSportConfig('futsal')).not.toHaveProperty('volleyball');
    expect(getDefaultSportConfig('badminton')).toHaveProperty('badminton');
    expect(getDefaultSportConfig('badminton')).not.toHaveProperty('volleyball');
    expect(getDefaultSportConfig('volleyball')).toHaveProperty('volleyball');
    expect(getDefaultSportConfig('volleyball')).not.toHaveProperty('badminton');
  });
});
