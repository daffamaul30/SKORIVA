/**
 * Clock display hook (T-31.7, shared ticker in T-31 remediation R1).
 *
 * Reads the single shared interpolation ticker, so any number of components can
 * show the clock without each owning an interval.
 *
 * Presentation only: the value is never sent back as authoritative state.
 *
 * Freezing rules:
 * - server says paused → no local tick;
 * - server says expired → no local tick;
 * - B-11 `recoveryPending` → frozen until `clock.confirm`;
 * - socket disconnected → frozen.
 */

import { useSyncExternalStore } from 'react';
import { getClockSnapshot, subscribeClock } from '../store/clock-ticker';
import { formatClock } from '../store/clock-anchor';
import { useMatchSession } from '../store/match-session.store';

export interface MatchClockView {
  remainingMs: number;
  formatted: string;
  isRunning: boolean;
  expired: boolean;
  frozen: boolean;
  shotClock?: { remainingMs: number; running: boolean; expired: boolean };
}

export function useMatchClock(): MatchClockView | null {
  const clock = useMatchSession((state) => state.clock);
  const recoveryPending = useMatchSession((state) => state.recoveryPending);
  const connection = useMatchSession((state) => state.connection);

  const remainingMs = useSyncExternalStore(subscribeClock, getClockSnapshot, getClockSnapshot);

  if (!clock) return null;

  const frozen = recoveryPending || !clock.isRunning || clock.expired || connection !== 'connected';

  return {
    remainingMs,
    formatted: formatClock(remainingMs),
    isRunning: clock.isRunning,
    expired: clock.expired,
    frozen,
    ...(clock.sportClock ? { shotClock: clock.sportClock } : {}),
  };
}
