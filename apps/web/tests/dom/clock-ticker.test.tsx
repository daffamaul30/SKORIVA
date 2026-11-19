/**
 * T-31 remediation R1 — one shared clock ticker.
 *
 * Verifies a single interval serves every subscriber, that it is released when
 * unused, and that paused/expired/recovery states never tick.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockSnapshot,
  resetClockTickerForTests,
  subscribeClock,
} from '@/features/match-session/store/clock-ticker';
import { useMatchClock } from '@/features/match-session/hooks/use-match-clock';
import { useMatchSession } from '@/features/match-session/store/match-session.store';

const session = useMatchSession;

const NOW = new Date('2026-11-19T10:00:00.000Z');

function startRunningClock(remainingMs = 60_000): void {
  session.getState().startSession('m-1', 'operator');
  session.getState().setConnection('connected');
  session.getState().applyClock({
    matchId: 'm-1',
    clock: { remainingMs, isRunning: true, expired: false },
    serverTs: NOW.toISOString(),
  });
}

beforeEach(() => {
  resetClockTickerForTests();
  session.getState().reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  resetClockTickerForTests();
  session.getState().reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared ticker', () => {
  it('creates a single interval for many subscribers', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    startRunningClock();

    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();

    const offFirst = subscribeClock(first);
    const offSecond = subscribeClock(second);
    const offThird = subscribeClock(third);

    expect(intervalSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(third).toHaveBeenCalled();

    // All subscribers read the same shared value.
    expect(getClockSnapshot()).toBe(59_000);

    offFirst();
    offSecond();
    offThird();
  });

  it('keeps the interval while at least one subscriber remains', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    startRunningClock();

    const offFirst = subscribeClock(() => undefined);
    const offSecond = subscribeClock(() => undefined);

    offFirst();
    expect(clearSpy).not.toHaveBeenCalled();

    offSecond();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the interval and store subscription when unused', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    startRunningClock();

    const unsubscribe = subscribeClock(() => undefined);
    unsubscribe();

    expect(clearSpy).toHaveBeenCalledTimes(1);

    const frozenValue = getClockSnapshot();

    // No listeners remain, so store changes must not recompute the snapshot.
    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 30_000, isRunning: true, expired: false },
      serverTs: NOW.toISOString(),
    });

    expect(getClockSnapshot()).toBe(frozenValue);
    expect(frozenValue).not.toBe(30_000);
  });

  it('is corrected immediately by a server anchor', () => {
    startRunningClock(60_000);
    const listener = vi.fn();
    const off = subscribeClock(listener);

    vi.advanceTimersByTime(2_000);
    expect(getClockSnapshot()).toBe(58_000);

    // Server tick re-anchors to its authoritative value.
    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 40_000, isRunning: true, expired: false },
      serverTs: new Date(NOW.getTime() + 2_000).toISOString(),
    });

    expect(getClockSnapshot()).toBe(40_000);
    expect(listener).toHaveBeenCalled();

    off();
  });
});

describe('freezing rules', () => {
  it('does not tick while the server says paused', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    session.getState().startSession('m-1', 'operator');
    session.getState().setConnection('connected');
    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 60_000, isRunning: false, expired: false },
      serverTs: NOW.toISOString(),
    });

    const off = subscribeClock(() => undefined);

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(getClockSnapshot()).toBe(60_000);

    off();
  });

  it('does not tick when expired', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    session.getState().startSession('m-1', 'operator');
    session.getState().setConnection('connected');
    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 0, isRunning: false, expired: true },
      serverTs: NOW.toISOString(),
    });

    const off = subscribeClock(() => undefined);

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(getClockSnapshot()).toBe(0);

    off();
  });

  it('does not tick during recovery freeze (B-11)', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    startRunningClock();
    session.getState().setRecoveryPending(true);

    const off = subscribeClock(() => undefined);

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(getClockSnapshot()).toBe(60_000);

    off();
  });

  it('does not tick while disconnected', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    startRunningClock();
    session.getState().setConnection('disconnected');

    const off = subscribeClock(() => undefined);

    expect(intervalSpy).not.toHaveBeenCalled();

    off();
  });

  it('stops ticking when the clock is paused mid-run', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    startRunningClock();
    const off = subscribeClock(() => undefined);

    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 45_000, isRunning: false, expired: false },
      serverTs: NOW.toISOString(),
    });

    expect(clearSpy).toHaveBeenCalled();

    off();
  });
});

describe('useMatchClock', () => {
  function ClockProbe({ label }: { label: string }) {
    const clock = useMatchClock();
    return (
      <output data-testid={label}>{clock ? clock.formatted : 'none'}</output>
    );
  }

  it('serves several components from one interval', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    startRunningClock(60_000);

    render(
      <>
        <ClockProbe label="a" />
        <ClockProbe label="b" />
        <ClockProbe label="c" />
      </>,
    );

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a')).toHaveTextContent('01:00');
    expect(screen.getByTestId('b')).toHaveTextContent('01:00');
    expect(screen.getByTestId('c')).toHaveTextContent('01:00');
  });

  it('returns null when there is no clock', () => {
    render(<ClockProbe label="empty" />);
    expect(screen.getByTestId('empty')).toHaveTextContent('none');
  });

  it('reports a frozen clock while recovery is pending', () => {
    startRunningClock();
    session.getState().setRecoveryPending(true);

    render(<ClockProbe label="frozen" />);

    expect(screen.getByTestId('frozen')).toHaveTextContent('01:00');
  });
});
