/**
 * Shared clock ticker (T-31 remediation R1).
 *
 * One interval for the whole app, shared by every component that displays the
 * clock. The ticker reads the authoritative anchor from the match-session store
 * and recomputes on every store change, so server snapshots correct it
 * immediately instead of waiting for the next tick.
 *
 * The ticker only runs while the server says the clock is running, the socket is
 * connected, and no recovery freeze is active (B-11). When the last subscriber
 * leaves, the interval and the store subscription are released.
 *
 * Presentation only: the interpolated value is never sent to the backend.
 */

import { interpolateRemainingMs } from './clock-anchor';
import { useMatchSession } from './match-session.store';

const TICK_INTERVAL_MS = 250;

let intervalId: ReturnType<typeof setInterval> | null = null;
let storeUnsubscribe: (() => void) | null = null;
let currentValue = 0;
const listeners = new Set<() => void>();

function computeValue(): number {
  const state = useMatchSession.getState();
  const clock = state.clock;

  if (!clock) return 0;

  const anchorTs = Date.parse(clock.serverTs);

  return interpolateRemainingMs({
    anchor: {
      remainingMs: clock.remainingMs,
      isRunning: clock.isRunning,
      expired: clock.expired,
      anchorServerTs: Number.isNaN(anchorTs) ? Date.now() : anchorTs,
    },
    nowMs: Date.now(),
    frozen: state.recoveryPending || state.connection !== 'connected',
  });
}

function shouldTick(): boolean {
  const state = useMatchSession.getState();
  const clock = state.clock;

  if (!clock) return false;
  if (state.recoveryPending) return false;
  if (state.connection !== 'connected') return false;

  return clock.isRunning && !clock.expired;
}

function notifyIfChanged(next: number): void {
  if (next === currentValue) return;

  currentValue = next;

  // Copy first: a listener may unsubscribe during the notification, which would
  // otherwise mutate the Set mid-iteration.
  for (const listener of [...listeners]) listener();

  // Reaching zero means the display has nothing left to interpolate.
  if (next === 0) stopTicker();
}

function startTicker(): void {
  if (intervalId !== null) return;

  intervalId = setInterval(() => {
    notifyIfChanged(computeValue());
  }, TICK_INTERVAL_MS);
}

function stopTicker(): void {
  if (intervalId === null) return;

  clearInterval(intervalId);
  intervalId = null;
}

function syncTicker(): void {
  if (shouldTick()) startTicker();
  else stopTicker();
}

function handleStoreChange(): void {
  notifyIfChanged(computeValue());
  syncTicker();
}

/** Subscribe a component to the shared interpolated value. */
export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) {
    storeUnsubscribe = useMatchSession.subscribe(handleStoreChange);
    currentValue = computeValue();
    syncTicker();
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      stopTicker();
      storeUnsubscribe?.();
      storeUnsubscribe = null;
    }
  };
}

/** Current interpolated value; `useSyncExternalStore` snapshot. */
export function getClockSnapshot(): number {
  return currentValue;
}

/** Test-only reset. Application code must never call this. */
export function resetClockTickerForTests(): void {
  stopTicker();
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  listeners.clear();
  currentValue = 0;
}
