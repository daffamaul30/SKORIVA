import { describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { ClockState, MatchState } from '@skoriva/shared';
import {
  ClockError,
  applyClockAction,
  applyClockEvent,
  checkpointClock,
  clockReducer,
  confirmClock,
  deriveRemainingMs,
  isClockExpired,
  pauseClock,
  recoverClock,
  resetClock,
  resetClockForPeriod,
  resumeClock,
  startClock,
  stopClock,
} from '../../src/core/clock.js';
import type { DispatchAction } from '../../src/core/match.service.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function clock(overrides: Partial<ClockState> = {}): ClockState {
  return {
    mode: 'timed',
    remainingMs: 600_000,
    isRunning: false,
    anchorServerTs: 0,
    lastDurableRemainingMs: 600_000,
    lastDurableAt: T0,
    recoveryPending: false,
    ...overrides,
  };
}

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: clock(),
    sportState: {},
    flags: { clockExpired: false, periodComplete: false },
    ...overrides,
  };
}

function action(
  type: DispatchAction['type'],
  payload: Record<string, unknown> = {},
): DispatchAction {
  return { type, payload, txId: 'tx-1', expectedVersion: 0 } as DispatchAction;
}

describe('derived clock value', () => {
  it('subtracts elapsed time only while running', () => {
    const running = clock({ isRunning: true, anchorServerTs: T0.getTime() });

    expect(deriveRemainingMs(running, at(60))).toBe(540_000);
    expect(deriveRemainingMs(running, at(600))).toBe(0);
    expect(deriveRemainingMs(running, at(900))).toBe(0);
  });

  it('returns the stored value while paused', () => {
    expect(deriveRemainingMs(clock({ remainingMs: 123_000 }), at(60))).toBe(123_000);
  });

  it('returns zero for mode none and never reports expiry', () => {
    const none = clock({ mode: 'none', remainingMs: 0 });

    expect(deriveRemainingMs(none, at(60))).toBe(0);
    expect(isClockExpired(none, at(60))).toBe(false);
  });
});

describe('clock transitions', () => {
  it('starts from an anchor and checkpoints', () => {
    const started = startClock(clock(), T0);

    expect(started.isRunning).toBe(true);
    expect(started.anchorServerTs).toBe(T0.getTime());
    expect(started.lastDurableRemainingMs).toBe(600_000);
    expect(started.lastDurableAt).toEqual(T0);
  });

  it('pauses without jumping and checkpoints the derived value', () => {
    const started = startClock(clock(), T0);
    const paused = pauseClock(started, at(60));

    expect(paused.isRunning).toBe(false);
    expect(paused.remainingMs).toBe(540_000);
    expect(paused.lastDurableRemainingMs).toBe(540_000);
    expect(deriveRemainingMs(paused, at(120))).toBe(540_000);
  });

  it('resumes from the paused value', () => {
    const started = startClock(clock(), T0);
    const paused = pauseClock(started, at(60));
    const resumed = resumeClock(paused, at(120));

    expect(resumed.isRunning).toBe(true);
    expect(resumed.anchorServerTs).toBe(at(120).getTime());
    expect(deriveRemainingMs(resumed, at(180))).toBe(480_000);
  });

  it('rejects invalid start/pause/resume sequences', () => {
    expect(() => startClock(clock({ isRunning: true }), T0)).toThrow(
      expect.objectContaining({ code: 'CLOCK_ALREADY_RUNNING' }),
    );
    expect(() => pauseClock(clock(), T0)).toThrow(
      expect.objectContaining({ code: 'CLOCK_NOT_RUNNING' }),
    );
    expect(() => resumeClock(clock({ isRunning: true }), T0)).toThrow(ClockError);
  });

  it('resets to the period duration and requires confirmation', () => {
    const reset = resetClock(clock({ remainingMs: 10_000 }), T0, 600_000);

    expect(reset.remainingMs).toBe(600_000);
    expect(reset.isRunning).toBe(false);
    expect(reset.recoveryPending).toBe(true);
    expect(reset.lastDurableRemainingMs).toBe(600_000);
  });

  it('confirms recovery and clears the pending flag', () => {
    const reset = resetClock(clock(), T0, 600_000);
    const confirmed = confirmClock(reset, at(10));

    expect(confirmed.recoveryPending).toBe(false);
    expect(confirmed.remainingMs).toBe(600_000);
    expect(confirmed.lastDurableRemainingMs).toBe(600_000);
  });

  it('stops and checkpoints on finish', () => {
    const started = startClock(clock(), T0);
    const stopped = stopClock(started, at(30));

    expect(stopped.isRunning).toBe(false);
    expect(stopped.remainingMs).toBe(570_000);
    expect(stopped.lastDurableRemainingMs).toBe(570_000);
  });

  it('prepares a new period without a recovery prompt', () => {
    const next = resetClockForPeriod(clock({ remainingMs: 0 }), at(60), 720_000);

    expect(next.remainingMs).toBe(720_000);
    expect(next.recoveryPending).toBe(false);
    expect(next.lastDurableRemainingMs).toBe(720_000);
  });

  it('rejects clock actions on a mode none match', () => {
    expect(() => startClock(clock({ mode: 'none' }), T0)).toThrow(
      expect.objectContaining({ code: 'CLOCK_MODE_NONE' }),
    );
  });
});

describe('clock expiry flag', () => {
  it('sets clockExpired without changing match status', () => {
    const started = startClock(clock({ remainingMs: 1_000 }), T0);
    const result = applyClockAction(
      state({ clock: started }),
      action('clock.pause'),
      BASKETBALL_DEFAULTS,
      at(1),
    );

    expect(result.state.flags.clockExpired).toBe(true);
    expect(result.state.clock.remainingMs).toBe(0);
    expect(result.emitted).toEqual(['clock.pause']);
  });
});

describe('recovery', () => {
  it('freezes at the last durable checkpoint and does not count downtime', () => {
    const started = startClock(clock(), T0);
    const recovered = recoverClock(started, at(300));

    expect(recovered.isRunning).toBe(false);
    expect(recovered.remainingMs).toBe(600_000);
    expect(recovered.recoveryPending).toBe(true);
    expect(recovered.anchorServerTs).toBe(0);
  });

  it('leaves a paused clock untouched', () => {
    const paused = clock({ remainingMs: 300_000, isRunning: false });
    expect(recoverClock(paused, at(300))).toEqual(paused);
  });

  it('keeps recovery pending across a refresh until confirm', () => {
    const recovered = recoverClock(startClock(clock(), T0), at(300));
    const refreshed = recoverClock(recovered, at(400));

    expect(refreshed.recoveryPending).toBe(true);
    expect(refreshed.remainingMs).toBe(600_000);

    const confirmed = confirmClock(refreshed, at(500));
    expect(confirmed.recoveryPending).toBe(false);
  });

  it('checkpoints only on meaningful transitions', () => {
    const started = startClock(clock(), T0);
    const checkpointed = checkpointClock(started, at(60));

    expect(checkpointed.lastDurableRemainingMs).toBe(540_000);
    expect(checkpointed.remainingMs).toBe(600_000);
    expect(checkpointed.anchorServerTs).toBe(T0.getTime());
  });
});

describe('clock reducer and replay folder', () => {
  it('handles clock actions and falls through for others', () => {
    const reducer = clockReducer(BASKETBALL_DEFAULTS);
    const started = reducer(state(), action('clock.start'), {} as never, T0);
    const other = reducer(state(), action('score.change'), {} as never, T0);

    expect(started.emitted).toEqual(['clock.start']);
    expect(started.state.clock.isRunning).toBe(true);
    expect(other.emitted).toEqual([]);
  });

  it('folds clock events deterministically using event serverTs', () => {
    const events = [
      { type: 'clock.start' as const, payload: {}, serverTs: T0 },
      { type: 'clock.pause' as const, payload: {}, serverTs: at(60) },
      { type: 'clock.resume' as const, payload: {}, serverTs: at(120) },
    ];

    const folded = events.reduce(
      (current, event) => applyClockEvent(current, event, BASKETBALL_DEFAULTS),
      state(),
    );

    expect(folded.clock.isRunning).toBe(true);
    expect(folded.clock.remainingMs).toBe(540_000);
    expect(deriveRemainingMs(folded.clock, at(180))).toBe(480_000);
  });
});
