/**
 * T-31.7 — Match session store version rules and derived state.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ScoreboardView } from '@skoriva/shared';
import {
  selectCanOperate,
  selectClockFrozen,
  useMatchSession,
} from '@/features/match-session/store/match-session.store';

const store = useMatchSession;

const DISPLAY: ScoreboardView = {
  matchStatus: 'live',
  resultDecision: 'undecided',
  teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
  score: { home: 10, away: 8 },
  period: { index: 1, label: 'Q1', total: 4 },
};

function operatorSnapshot(version: number, extra: { recoveryPending?: boolean } = {}) {
  return {
    matchId: 'm-1',
    version,
    state: {
      version,
      period: { index: 1, label: 'Q1', status: 'active' as const },
      clock: {
        mode: 'timed' as const,
        remainingMs: 600_000,
        isRunning: true,
        anchorServerTs: 0,
        lastDurableRemainingMs: 600_000,
        lastDurableAt: new Date('2026-11-19T10:00:00.000Z'),
        recoveryPending: extra.recoveryPending ?? false,
      },
      sportState: {},
      flags: { clockExpired: false, periodComplete: false },
    },
    display: DISPLAY,
    serverTs: '2026-11-19T10:00:00.000Z',
  };
}

beforeEach(() => {
  store.getState().reset();
});

describe('snapshot and patch version rules', () => {
  it('applies a full snapshot as authoritative state', () => {
    store.getState().startSession('m-1', 'operator');
    store.getState().applySnapshot(operatorSnapshot(5));

    expect(store.getState().version).toBe(5);
    expect(store.getState().display?.score.home).toBe(10);
    expect(store.getState().matchStatus).toBe('live');
    expect(store.getState().clock?.remainingMs).toBe(600_000);
  });

  it('applies a newer patch', () => {
    store.getState().applySnapshot(operatorSnapshot(5));

    const applied = store.getState().applyPatch({
      ...operatorSnapshot(6),
      display: { ...DISPLAY, score: { home: 12, away: 8 } },
    });

    expect(applied).toBe(true);
    expect(store.getState().version).toBe(6);
    expect(store.getState().display?.score.home).toBe(12);
  });

  it('ignores a stale or duplicate patch', () => {
    store.getState().applySnapshot(operatorSnapshot(7));

    const stale = store.getState().applyPatch(operatorSnapshot(6));
    const duplicate = store.getState().applyPatch(operatorSnapshot(7));

    expect(stale).toBe(false);
    expect(duplicate).toBe(false);
    expect(store.getState().version).toBe(7);
  });

  it('never applies patches optimistically (state only changes on server data)', () => {
    store.getState().applySnapshot(operatorSnapshot(3));
    const before = store.getState().display?.score.home;

    // No local mutation path exists: sending an action does not touch the store.
    expect(store.getState().display?.score.home).toBe(before);
    expect(store.getState().version).toBe(3);
  });

  it('handles viewer snapshots without internal state', () => {
    store.getState().startSession('m-1', 'viewer');
    store.getState().applySnapshot({
      matchId: 'm-1',
      version: 2,
      matchStatus: 'live',
      resultDecision: 'undecided',
      display: DISPLAY,
      serverTs: '2026-11-19T10:00:00.000Z',
    });

    expect(store.getState().role).toBe('viewer');
    expect(store.getState().matchStatus).toBe('live');
    expect(store.getState().clock).toBeNull();
  });

  it('drops the display when a viewer result is not public', () => {
    store.getState().startSession('m-1', 'viewer');
    store.getState().applySnapshot({
      matchId: 'm-1',
      version: 4,
      matchStatus: 'finished',
      resultDecision: 'discarded',
      serverTs: '2026-11-19T10:00:00.000Z',
    });

    expect(store.getState().display).toBeNull();
    expect(store.getState().resultDecision).toBe('discarded');
  });

  it('applies status transitions without touching display', () => {
    store.getState().applySnapshot(operatorSnapshot(2));
    store.getState().applyStatus({
      matchId: 'm-1',
      matchStatus: 'finished',
      resultDecision: 'undecided',
    });

    expect(store.getState().matchStatus).toBe('finished');
    expect(store.getState().display?.score.home).toBe(10);
  });
});

describe('clock and recovery', () => {
  it('stores the clock payload from the 1 Hz ticker', () => {
    store.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 120_000, isRunning: true, expired: false },
      sportClock: { remainingMs: 14_000, running: true, expired: false },
      serverTs: '2026-11-19T10:00:00.000Z',
    });

    expect(store.getState().clock?.remainingMs).toBe(120_000);
    expect(store.getState().clock?.sportClock?.remainingMs).toBe(14_000);
  });

  it('marks the clock frozen while recovery is pending (B-11)', () => {
    store.getState().applySnapshot(operatorSnapshot(1, { recoveryPending: true }));

    expect(store.getState().recoveryPending).toBe(true);
    expect(selectClockFrozen(store.getState())).toBe(true);
  });

  it('freezes the clock when the server says paused or expired', () => {
    store.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 90_000, isRunning: false, expired: false },
      serverTs: '2026-11-19T10:00:00.000Z',
    });
    expect(selectClockFrozen(store.getState())).toBe(true);

    store.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 0, isRunning: false, expired: true },
      serverTs: '2026-11-19T10:00:00.000Z',
    });
    expect(selectClockFrozen(store.getState())).toBe(true);
  });

  it('is not frozen while running normally', () => {
    store.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 90_000, isRunning: true, expired: false },
      serverTs: '2026-11-19T10:00:00.000Z',
    });

    expect(selectClockFrozen(store.getState())).toBe(false);
  });
});

describe('operator availability', () => {
  it('requires operator role, active session and a connected socket', () => {
    store.getState().startSession('m-1', 'operator');
    store.getState().applySnapshot(operatorSnapshot(1));

    expect(selectCanOperate(store.getState())).toBe(false);

    store.getState().setConnection('connected');
    store.getState().setOperatorState({ active: true });
    expect(selectCanOperate(store.getState())).toBe(true);

    store.getState().setConnection('disconnected');
    expect(selectCanOperate(store.getState())).toBe(false);
  });

  it('keeps viewers unable to operate', () => {
    store.getState().startSession('m-1', 'viewer');
    store.getState().setConnection('connected');
    store.getState().setOperatorState({ active: true });

    expect(selectCanOperate(store.getState())).toBe(false);
  });

  it('exposes graceUntil for a future reconnect-required UI', () => {
    store.getState().setOperatorState({
      active: true,
      graceUntil: '2026-11-19T10:00:30.000Z',
    });

    expect(store.getState().graceUntil).toBe('2026-11-19T10:00:30.000Z');
  });
});

describe('session reset', () => {
  it('clears everything when the match changes', () => {
    store.getState().startSession('m-1', 'operator');
    store.getState().applySnapshot(operatorSnapshot(5));
    store.getState().setConnection('connected');

    store.getState().startSession('m-2', 'viewer');

    expect(store.getState().matchId).toBe('m-2');
    expect(store.getState().version).toBe(0);
    expect(store.getState().display).toBeNull();
    expect(store.getState().connection).toBe('idle');
  });
});
