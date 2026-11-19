/**
 * Game clock anchor, transitions, and recovery (T-16, Tech Spec §4.2, B-11).
 *
 * The clock stores an anchor, not a per-tick value:
 *   remaining(now) = max(0, remainingMs - (now - anchorServerTs))
 * when running, and `remainingMs` when paused. No DB write happens per tick.
 *
 * A durable checkpoint (`lastDurableRemainingMs` / `lastDurableAt`) is written
 * only on meaningful transitions: start, pause, resume, reset, period change,
 * shot-clock reset, and finish.
 *
 * Recovery freezes the clock at the last durable checkpoint, does not count
 * downtime, sets `recoveryPending = true`, and waits for `clock.confirm`.
 * `clockExpired` is a flag, never a match-status transition (LC-01).
 */

import type {
  ClockState,
  EventType,
  MatchConfig,
  MatchEventPayload,
  MatchState,
} from '@skoriva/shared';
import type { DispatchAction, ReduceOutcome, StateReducer } from './match.service.js';

export type ClockErrorCode =
  | 'CLOCK_MODE_NONE'
  | 'CLOCK_ALREADY_RUNNING'
  | 'CLOCK_NOT_RUNNING'
  | 'INVALID_REMAINING_MS'
  | 'INVALID_PERIOD_DURATION';

export class ClockError extends Error {
  constructor(
    readonly code: ClockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClockError';
  }
}

/** Derived remaining time; the only read path for the running clock. */
export function deriveRemainingMs(clock: ClockState, now: Date): number {
  if (clock.mode === 'none') return 0;

  if (!clock.isRunning) {
    return Math.max(0, clock.remainingMs);
  }

  const elapsed = now.getTime() - clock.anchorServerTs;
  return Math.max(0, clock.remainingMs - Math.max(0, elapsed));
}

/** `clockExpired` is a flag for a timed clock that has reached zero. */
export function isClockExpired(clock: ClockState, now: Date): boolean {
  return clock.mode === 'timed' && deriveRemainingMs(clock, now) === 0;
}

/** Persist a durable checkpoint without altering the running anchor. */
export function checkpointClock(clock: ClockState, now = new Date()): ClockState {
  return {
    ...clock,
    lastDurableRemainingMs: deriveRemainingMs(clock, now),
    lastDurableAt: now,
  };
}

/**
 * Freeze a clock that was running (or already flagged) at shutdown. Downtime is
 * not counted; the caller must persist this state and emit the recovery flag.
 */
export function recoverClock(clock: ClockState, now = new Date()): ClockState {
  if (!clock.recoveryPending && !clock.isRunning) return clock;

  return {
    ...clock,
    remainingMs: clock.lastDurableRemainingMs,
    isRunning: false,
    anchorServerTs: 0,
    recoveryPending: true,
    lastDurableAt: now,
  };
}

function assertTimed(clock: ClockState): void {
  if (clock.mode === 'none') {
    throw new ClockError('CLOCK_MODE_NONE', 'This match has no timed game clock.');
  }
}

function assertRemaining(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new ClockError('INVALID_REMAINING_MS', 'remainingMs must be a non-negative integer.');
  }
}

function assertPeriodDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new ClockError('INVALID_PERIOD_DURATION', 'Period duration must be positive.');
  }
}

export function startClock(clock: ClockState, now: Date, remainingMs?: number): ClockState {
  assertTimed(clock);
  assertRemaining(remainingMs);

  if (clock.isRunning) {
    throw new ClockError('CLOCK_ALREADY_RUNNING', 'Clock is already running.');
  }

  const remaining = remainingMs ?? clock.remainingMs;
  const running: ClockState = {
    ...clock,
    remainingMs: remaining,
    isRunning: true,
    anchorServerTs: now.getTime(),
    recoveryPending: false,
  };

  return checkpointClock(running, now);
}

export function pauseClock(clock: ClockState, now: Date): ClockState {
  assertTimed(clock);

  if (!clock.isRunning) {
    throw new ClockError('CLOCK_NOT_RUNNING', 'Clock is not running.');
  }

  const paused: ClockState = {
    ...clock,
    remainingMs: deriveRemainingMs(clock, now),
    isRunning: false,
    anchorServerTs: 0,
  };

  return checkpointClock(paused, now);
}

export function resumeClock(clock: ClockState, now: Date, remainingMs?: number): ClockState {
  assertTimed(clock);
  assertRemaining(remainingMs);

  if (clock.isRunning) {
    throw new ClockError('CLOCK_ALREADY_RUNNING', 'Clock is already running.');
  }

  const remaining = remainingMs ?? clock.remainingMs;
  const running: ClockState = {
    ...clock,
    remainingMs: remaining,
    isRunning: true,
    anchorServerTs: now.getTime(),
    recoveryPending: false,
  };

  return checkpointClock(running, now);
}

/** Reset to the configured period duration; requires `clock.confirm`. */
export function resetClock(clock: ClockState, now: Date, periodDurationMs: number): ClockState {
  assertTimed(clock);
  assertPeriodDuration(periodDurationMs);

  return {
    ...clock,
    remainingMs: periodDurationMs,
    isRunning: false,
    anchorServerTs: 0,
    lastDurableRemainingMs: periodDurationMs,
    lastDurableAt: now,
    recoveryPending: true,
  };
}

/** Operator acknowledgement after recovery/reset. */
export function confirmClock(clock: ClockState, now: Date, remainingMs?: number): ClockState {
  assertTimed(clock);
  assertRemaining(remainingMs);

  const remaining = remainingMs ?? clock.lastDurableRemainingMs;

  return {
    ...clock,
    remainingMs: remaining,
    isRunning: false,
    anchorServerTs: 0,
    lastDurableRemainingMs: remaining,
    lastDurableAt: now,
    recoveryPending: false,
  };
}

/** Stop and checkpoint the clock on finish (no recovery prompt). */
export function stopClock(clock: ClockState, now: Date): ClockState {
  const stopped: ClockState = {
    ...clock,
    remainingMs: deriveRemainingMs(clock, now),
    isRunning: false,
    anchorServerTs: 0,
  };

  return checkpointClock(stopped, now);
}

/** Prepare the clock for a new period and checkpoint it (B-11 / FIX 3). */
export function resetClockForPeriod(
  clock: ClockState,
  now: Date,
  periodDurationMs: number,
): ClockState {
  assertPeriodDuration(periodDurationMs);

  return {
    ...clock,
    remainingMs: periodDurationMs,
    isRunning: false,
    anchorServerTs: 0,
    lastDurableRemainingMs: periodDurationMs,
    lastDurableAt: now,
    recoveryPending: false,
  };
}

function withClock(
  state: MatchState,
  clock: ClockState,
  now: Date,
  emitted: EventType[],
): ReduceOutcome {
  return {
    state: {
      ...state,
      clock,
      sportState: state.sportState ?? {},
      flags: { ...state.flags, clockExpired: isClockExpired(clock, now) },
    },
    emitted,
  };
}

/** Apply a `clock.*` action. Non-clock actions are returned unchanged. */
export function applyClockAction(
  state: MatchState,
  action: DispatchAction,
  config: MatchConfig,
  now: Date,
): ReduceOutcome {
  const periodDurationMs = config.periods.durationMs;
  const payload = (action.payload ?? {}) as { remainingMs?: number };

  switch (action.type) {
    case 'clock.start':
      return withClock(state, startClock(state.clock, now, payload.remainingMs), now, [
        'clock.start',
      ]);

    case 'clock.pause':
      return withClock(state, pauseClock(state.clock, now), now, ['clock.pause']);

    case 'clock.resume':
      return withClock(state, resumeClock(state.clock, now, payload.remainingMs), now, [
        'clock.resume',
      ]);

    case 'clock.reset':
      return withClock(state, resetClock(state.clock, now, periodDurationMs), now, ['clock.reset']);

    case 'clock.confirm':
      return withClock(state, confirmClock(state.clock, now, payload.remainingMs), now, [
        'clock.confirm',
      ]);

    default:
      return { state, emitted: [] };
  }
}

/**
 * T-12 reducer for clock actions. Compose it with the sport-engine reducer:
 * clock actions are handled here, other actions fall through with no emitted
 * events so the sport folder can handle them.
 */
export function clockReducer(config: MatchConfig): StateReducer {
  return (state, action, _match, now) => applyClockAction(state, action, config, now);
}

export interface ClockEventLike {
  type: EventType;
  payload: MatchEventPayload;
  serverTs: Date;
}

/**
 * Replay folder for clock events. Uses the event's `serverTs` so a paused or
 * confirmed clock folds to exactly the same state.
 */
export function applyClockEvent(
  state: MatchState,
  event: ClockEventLike,
  config: MatchConfig,
): MatchState {
  const result = applyClockAction(
    state,
    {
      type: event.type as DispatchAction['type'],
      payload: event.payload ?? {},
      txId: '',
      expectedVersion: state.version,
    } as DispatchAction,
    config,
    event.serverTs,
  );

  return result.state;
}
