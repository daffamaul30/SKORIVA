import { describe, expect, it } from 'vitest';
import {
  BADMINTON_DEFAULTS as SHARED_BADMINTON,
  BASKETBALL_DEFAULTS as SHARED_BASKETBALL,
  FUTSAL_DEFAULTS as SHARED_FUTSAL,
  VOLLEYBALL_DEFAULTS as SHARED_VOLLEYBALL,
} from '@skoriva/shared';
import type { MatchConfig } from '@skoriva/shared';
import {
  BADMINTON_DEFAULTS,
  BASKETBALL_DEFAULTS,
  FUTSAL_DEFAULTS,
  VOLLEYBALL_DEFAULTS,
} from '../../src/sports/shared/constants.js';
import { validateSportConfig } from '../../src/sports/shared/config-validation.js';

function withConfig(base: MatchConfig, patch: (config: MatchConfig) => void): MatchConfig {
  const config = structuredClone(base);
  patch(config);
  return config;
}

describe('default configuration parity with @skoriva/shared', () => {
  it('matches the shared defaults for every sport', () => {
    expect(BASKETBALL_DEFAULTS).toEqual(SHARED_BASKETBALL);
    expect(FUTSAL_DEFAULTS).toEqual(SHARED_FUTSAL);
    expect(BADMINTON_DEFAULTS).toEqual(SHARED_BADMINTON);
    expect(VOLLEYBALL_DEFAULTS).toEqual(SHARED_VOLLEYBALL);
  });
});

describe('validateSportConfig', () => {
  it('accepts the defaults for every sport', () => {
    expect(validateSportConfig('basketball', BASKETBALL_DEFAULTS).ok).toBe(true);
    expect(validateSportConfig('futsal', FUTSAL_DEFAULTS).ok).toBe(true);
    expect(validateSportConfig('badminton', BADMINTON_DEFAULTS).ok).toBe(true);
    expect(validateSportConfig('volleyball', VOLLEYBALL_DEFAULTS).ok).toBe(true);
  });

  it('rejects timeout configuration anywhere in the tree', () => {
    const config = withConfig(BASKETBALL_DEFAULTS, (value) => {
      (value as unknown as { timeout: boolean }).timeout = true;
    });

    expect(validateSportConfig('basketball', config)).toMatchObject({ ok: false });
  });

  it('rejects invalid basketball configuration', () => {
    expect(
      validateSportConfig(
        'basketball',
        withConfig(BASKETBALL_DEFAULTS, (value) => {
          value.gameClock = { mode: 'none' };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'basketball',
        withConfig(BASKETBALL_DEFAULTS, (value) => {
          value.shotClock = { enabled: false };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'basketball',
        withConfig(BASKETBALL_DEFAULTS, (value) => {
          value.periods.count = 9;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'basketball',
        withConfig(BASKETBALL_DEFAULTS, (value) => {
          value.shotClock = { enabled: true, durationMs: 5_000 };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'basketball',
        withConfig(BASKETBALL_DEFAULTS, (value) => {
          value.scoring.pointsPerGoal = [2, 4];
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects invalid futsal configuration', () => {
    expect(
      validateSportConfig(
        'futsal',
        withConfig(FUTSAL_DEFAULTS, (value) => {
          value.shotClock = { enabled: true, durationMs: 24_000 };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'futsal',
        withConfig(FUTSAL_DEFAULTS, (value) => {
          value.periods.count = 5;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'futsal',
        withConfig(FUTSAL_DEFAULTS, (value) => {
          value.scoring.pointsPerGoal = [1, 2];
        }),
      ).ok,
    ).toBe(false);
  });

  it('accepts futsal with the clock disabled', () => {
    const config = withConfig(FUTSAL_DEFAULTS, (value) => {
      value.gameClock = { mode: 'none' };
    });

    expect(validateSportConfig('futsal', config).ok).toBe(true);
  });

  it('rejects invalid badminton configuration', () => {
    expect(
      validateSportConfig(
        'badminton',
        withConfig(BADMINTON_DEFAULTS, (value) => {
          value.gameClock = { mode: 'timed', allowStop: true };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'badminton',
        withConfig(BADMINTON_DEFAULTS, (value) => {
          value.badminton = undefined;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'badminton',
        withConfig(BADMINTON_DEFAULTS, (value) => {
          if (value.badminton) value.badminton.pointCap = 50;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'badminton',
        withConfig(BADMINTON_DEFAULTS, (value) => {
          value.periods.count = 5;
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects invalid volleyball configuration', () => {
    expect(
      validateSportConfig(
        'volleyball',
        withConfig(VOLLEYBALL_DEFAULTS, (value) => {
          value.gameClock = { mode: 'timed', allowStop: true };
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'volleyball',
        withConfig(VOLLEYBALL_DEFAULTS, (value) => {
          if (value.volleyball) value.volleyball.bestOf = 4 as 3;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'volleyball',
        withConfig(VOLLEYBALL_DEFAULTS, (value) => {
          if (value.volleyball) value.volleyball.pointTarget = 14;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateSportConfig(
        'volleyball',
        withConfig(VOLLEYBALL_DEFAULTS, (value) => {
          value.periods.count = 5;
        }),
      ).ok,
    ).toBe(false);
  });

  it('accepts volleyball best-of-five with five periods', () => {
    const config = withConfig(VOLLEYBALL_DEFAULTS, (value) => {
      if (value.volleyball) value.volleyball.bestOf = 5;
      value.periods.count = 5;
      value.periods.labels = ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'];
    });

    expect(validateSportConfig('volleyball', config).ok).toBe(true);
  });
});
