/**
 * Basketball sport state (T-20).
 *
 * Shot clock lives in `sportState`, never in the core clock (BR-13). Fouls are
 * a simple total counter with no foul-out or bonus.
 */

import type { MatchConfig } from '@skoriva/shared';

export interface BasketballShotClockState {
  remainingMs: number;
  running: boolean;
  anchorServerTs: number;
  lastDurableRemainingMs: number;
  lastDurableAt: string;
  expired: boolean;
}

export interface BasketballState extends Record<string, unknown> {
  score: { home: number; away: number };
  fouls: { home: number; away: number };
  shotClock: BasketballShotClockState;
  /** Number of scoring/sport actions in the current period (B-01 guard). */
  periodActionCount: number;
}

export function initBasketballState(config: MatchConfig): BasketballState {
  const durationMs = config.shotClock.enabled ? config.shotClock.durationMs : 0;

  return {
    score: { home: 0, away: 0 },
    fouls: { home: 0, away: 0 },
    shotClock: {
      remainingMs: durationMs,
      running: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: durationMs,
      lastDurableAt: new Date(0).toISOString(),
      expired: false,
    },
    periodActionCount: 0,
  };
}
