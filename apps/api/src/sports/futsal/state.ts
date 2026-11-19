/**
 * Futsal sport state (T-21).
 *
 * Goals are +1; cards are simple total counters with no automatic effect (D-09).
 */

import type { MatchConfig } from '@skoriva/shared';

export interface FutsalCards {
  yellow: number;
  red: number;
}

export interface FutsalState extends Record<string, unknown> {
  score: { home: number; away: number };
  cards: { home: FutsalCards; away: FutsalCards };
  periodActionCount: number;
}

export function initFutsalState(_config: MatchConfig): FutsalState {
  return {
    score: { home: 0, away: 0 },
    cards: {
      home: { yellow: 0, red: 0 },
      away: { yellow: 0, red: 0 },
    },
    periodActionCount: 0,
  };
}
