/**
 * Default sport configuration selector (Task T-02, PRD FR-03).
 *
 * A sport is selected and its default configuration is returned. The switch is
 * exhaustive over the `Sport` union so that adding a new sport makes the
 * compiler point at this function.
 */

import type { SportConfigBySport } from '../domain/match-config.js';
import type { Sport } from '../domain/sport.js';
import { BASKETBALL_DEFAULTS } from './basketball.js';
import { BADMINTON_DEFAULTS } from './badminton.js';
import { FUTSAL_DEFAULTS } from './futsal.js';
import { VOLLEYBALL_DEFAULTS } from './volleyball.js';

/** All default configurations keyed by sport. */
export const SPORT_DEFAULTS: { readonly [S in Sport]: SportConfigBySport[S] } = {
  basketball: BASKETBALL_DEFAULTS,
  futsal: FUTSAL_DEFAULTS,
  badminton: BADMINTON_DEFAULTS,
  volleyball: VOLLEYBALL_DEFAULTS,
};

/**
 * Default configuration for a sport. Returns a fresh copy so callers cannot
 * mutate the shared default object.
 */
export function getDefaultSportConfig<S extends Sport>(sport: S): SportConfigBySport[S] {
  switch (sport) {
    case 'basketball':
      return structuredClone(BASKETBALL_DEFAULTS) as SportConfigBySport[S];
    case 'futsal':
      return structuredClone(FUTSAL_DEFAULTS) as SportConfigBySport[S];
    case 'badminton':
      return structuredClone(BADMINTON_DEFAULTS) as SportConfigBySport[S];
    case 'volleyball':
      return structuredClone(VOLLEYBALL_DEFAULTS) as SportConfigBySport[S];
    default: {
      const unreachable: never = sport;
      throw new Error(`Unsupported sport: ${String(unreachable)}`);
    }
  }
}
