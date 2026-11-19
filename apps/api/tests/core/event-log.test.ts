import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { EventType, MatchState } from '@skoriva/shared';
import {
  ACCESS_EVENT_TYPES,
  CONTEXT_EVENT_TYPES,
  LIFECYCLE_EVENT_TYPES,
  OPERATIONAL_EVENT_TYPES,
  EventLogError,
  buildEventLog,
  buildSingleEvent,
  eventLogBuilder,
  isAccessEventType,
  isContextEventType,
  isKnownEventType,
  isLifecycleEventType,
  isOperationalEventType,
  nextSequence,
} from '../../src/core/event-log.js';
import { MatchService } from '../../src/core/match.service.js';
import type { DispatchAction, DispatchContext } from '../../src/core/match.service.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import { EVENT_TYPES } from '../../src/models/enums.js';
import type { MatchDocument } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

const actor = { type: 'operator' as const, id: 'op-1' };

const context: DispatchContext = { actor, now: T0 };

function fakeMatch(): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    matchStatus: 'live',
    resultDecision: 'undecided',
    state: fakeState(),
  } as MatchDocument;
}

function fakeState(version = 0): MatchState {
  return {
    version,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 600_000,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: 600_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: {},
    flags: { clockExpired: false, periodComplete: false },
  };
}

function action(overrides: Partial<DispatchAction> = {}): DispatchAction {
  return {
    type: 'score.change',
    payload: { side: 'home', points: 2 },
    txId: 'tx-1',
    expectedVersion: 0,
    ...overrides,
  } as DispatchAction;
}

describe('sequence assignment', () => {
  it('assigns contiguous monotonic sequence numbers', () => {
    expect(nextSequence(0, 3)).toEqual([1, 2, 3]);
    expect(nextSequence(5, 2)).toEqual([6, 7]);
  });

  it('rejects invalid sequence inputs', () => {
    expect(() => nextSequence(-1, 1)).toThrow(EventLogError);
    expect(() => nextSequence(0, 0)).toThrow(EventLogError);
  });
});

describe('buildEventLog', () => {
  it('builds a single event with the action txId', () => {
    const events = buildEventLog({
      match: fakeMatch(),
      action: action(),
      state: fakeState(),
      emitted: ['score.change'],
      maxSeq: 0,
      now: T0,
      actor,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      txId: 'tx-1',
      type: 'score.change',
      actor,
    });
  });

  it('builds multiple events with unique derived txIds and contiguous seq', () => {
    const events = buildEventLog({
      match: fakeMatch(),
      action: action({ type: 'period.next', payload: {} }),
      state: fakeState(4),
      emitted: ['score.change', 'period.next'],
      maxSeq: 4,
      now: T0,
      actor,
    });

    expect(events.map((event) => event.seq)).toEqual([5, 6]);
    expect(events.map((event) => event.txId)).toEqual(['tx-1', 'tx-1:6']);
    expect(new Set(events.map((event) => event.txId)).size).toBe(2);
  });

  it('falls back to the action type when no emitted list is provided', () => {
    const [event] = buildEventLog({
      match: fakeMatch(),
      action: action({ type: 'clock.confirm', payload: { remainingMs: 1000 } }),
      state: fakeState(),
      emitted: [],
      maxSeq: 0,
      now: T0,
      actor,
    });

    expect(event?.type).toBe('clock.confirm');
  });

  it('rejects unknown and timeout event types', () => {
    expect(() =>
      buildEventLog({
        match: fakeMatch(),
        action: action(),
        state: fakeState(),
        emitted: ['timeout' as EventType],
        maxSeq: 0,
        now: T0,
        actor,
      }),
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_EVENT_TYPE' }));

    expect(() =>
      buildEventLog({
        match: fakeMatch(),
        action: action(),
        state: fakeState(),
        emitted: ['unknown.event' as EventType],
        maxSeq: 0,
        now: T0,
        actor,
      }),
    ).toThrow(EventLogError);
  });

  it('rejects a derived txId that exceeds the repository limit', () => {
    expect(() =>
      buildEventLog({
        match: fakeMatch(),
        action: action({ txId: 'x'.repeat(128) }),
        state: fakeState(),
        emitted: ['score.change', 'period.next'],
        maxSeq: 0,
        now: T0,
        actor,
      }),
    ).toThrow(expect.objectContaining({ code: 'TX_ID_TOO_LONG' }));
  });
});

describe('event catalogue', () => {
  it('covers every known event type exactly once', () => {
    const categorized = [
      ...LIFECYCLE_EVENT_TYPES,
      ...OPERATIONAL_EVENT_TYPES,
      ...ACCESS_EVENT_TYPES,
      ...CONTEXT_EVENT_TYPES,
    ];

    expect(new Set(categorized).size).toBe(categorized.length);
    expect([...categorized].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('classifies event types', () => {
    expect(isLifecycleEventType('match.start')).toBe(true);
    expect(isOperationalEventType('clock.confirm')).toBe(true);
    expect(isAccessEventType('operator.handover')).toBe(true);
    expect(isContextEventType('context.update')).toBe(true);
    expect(isOperationalEventType('match.start')).toBe(false);
    expect(isKnownEventType('timeout')).toBe(false);
  });

  it('builds a single lifecycle event', () => {
    const event = buildSingleEvent({
      seq: 3,
      txId: 'lifecycle-1',
      type: 'match.start',
      payload: { from: 'ready' },
      actor,
      now: T0,
    });

    expect(event).toMatchObject({ seq: 3, txId: 'lifecycle-1', type: 'match.start' });
  });
});

describe('event log integration with the action pipeline', () => {
  it('persists a multi-event action in one persist call and one ack', async () => {
    const match = fakeMatch();
    const persist = vi.fn(async ({ events }: { events: { seq: number; txId: string }[] }) => ({
      status: 'committed' as const,
      events: events.map((event) => ({
        _id: new Types.ObjectId(),
        matchId: match._id,
        seq: event.seq,
        txId: event.txId,
        type: 'score.change' as const,
        payload: {},
        actor,
        serverTs: T0,
        appliedAt: T0,
      })),
    }));

    const service = new MatchService({
      authorize: async () => undefined,
      loadMatch: async () => ({
        match,
        events: [],
        lastSeq: 0,
        lastStateAffectingSeq: 0,
        maxSeq: 0,
        needsReplay: false,
      }),
      reduce: () => ({
        state: fakeState(),
        emitted: ['score.change', 'period.next'],
      }),
      buildEvents: eventLogBuilder,
      persist,
      queue: new MatchQueue(),
    });

    const result = await service.dispatch('match-1', action(), context);

    expect(result.status).toBe('committed');
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0].events).toHaveLength(2);
    if (result.status === 'committed') {
      expect(result.version).toBe(2);
      expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
    }
  });
});
