/**
 * Presentation-only clock interpolation (T-31.7).
 *
 * The server is authoritative. This helper derives a display value between
 * server ticks; the result is never sent back and never stored as state.
 *
 * It deliberately refuses to run when:
 * - the server says the clock is paused (`isRunning: false`);
 * - the clock already expired;
 * - a recovery freeze is active (B-11) — the caller passes `frozen`.
 */

export interface ClockAnchor {
  remainingMs: number;
  isRunning: boolean;
  expired: boolean;
  /** Epoch ms when `remainingMs` was sampled. */
  anchorServerTs: number;
}

export interface InterpolateInput {
  anchor: ClockAnchor;
  nowMs: number;
  /** B-11 recovery freeze or disconnected socket. */
  frozen?: boolean;
}

export function interpolateRemainingMs({ anchor, nowMs, frozen = false }: InterpolateInput): number {
  if (frozen || !anchor.isRunning || anchor.expired) {
    return anchor.remainingMs;
  }

  const elapsed = nowMs - anchor.anchorServerTs;
  if (elapsed <= 0) {
    return anchor.remainingMs;
  }

  return Math.max(0, anchor.remainingMs - elapsed);
}

/** `mm:ss` for a non-negative millisecond duration; never negative. */
export function formatClock(remainingMs: number): string {
  const safe = Math.max(0, Math.floor(remainingMs));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
