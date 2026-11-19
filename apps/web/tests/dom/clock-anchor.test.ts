/**
 * T-31.7 — Clock interpolation is presentation-only.
 */

import { describe, expect, it } from 'vitest';
import { formatClock, interpolateRemainingMs } from '@/features/match-session/store/clock-anchor';

const BASE = 1_000_000;

function anchor(overrides: Partial<Parameters<typeof interpolateRemainingMs>[0]['anchor']> = {}) {
  return {
    remainingMs: 60_000,
    isRunning: true,
    expired: false,
    anchorServerTs: BASE,
    ...overrides,
  };
}

describe('interpolateRemainingMs', () => {
  it('counts down while the server clock is running', () => {
    expect(interpolateRemainingMs({ anchor: anchor(), nowMs: BASE + 5_000 })).toBe(55_000);
  });

  it('does not tick when the server says paused', () => {
    const paused = anchor({ isRunning: false });

    expect(interpolateRemainingMs({ anchor: paused, nowMs: BASE + 30_000 })).toBe(60_000);
  });

  it('does not tick when expired', () => {
    const expired = anchor({ remainingMs: 0, isRunning: false, expired: true });

    expect(interpolateRemainingMs({ anchor: expired, nowMs: BASE + 30_000 })).toBe(0);
  });

  it('freezes during recovery (B-11) even if the anchor says running', () => {
    expect(
      interpolateRemainingMs({ anchor: anchor(), nowMs: BASE + 20_000, frozen: true }),
    ).toBe(60_000);
  });

  it('never returns a negative value', () => {
    expect(interpolateRemainingMs({ anchor: anchor(), nowMs: BASE + 90_000 })).toBe(0);
  });

  it('ignores a clock skew that would move time backwards', () => {
    expect(interpolateRemainingMs({ anchor: anchor(), nowMs: BASE - 5_000 })).toBe(60_000);
  });

  it('is corrected immediately by a new server anchor', () => {
    const drifted = interpolateRemainingMs({ anchor: anchor(), nowMs: BASE + 10_000 });
    expect(drifted).toBe(50_000);

    // Server tick re-anchors: remainingMs is authoritative again.
    const corrected = interpolateRemainingMs({
      anchor: anchor({ remainingMs: 47_000, anchorServerTs: BASE + 10_000 }),
      nowMs: BASE + 10_000,
    });
    expect(corrected).toBe(47_000);
  });
});

describe('formatClock', () => {
  it('formats mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(59_000)).toBe('00:59');
    expect(formatClock(60_000)).toBe('01:00');
    expect(formatClock(600_000)).toBe('10:00');
  });

  it('clamps negatives to zero', () => {
    expect(formatClock(-1_000)).toBe('00:00');
  });
});
