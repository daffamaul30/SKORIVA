/**
 * Append-only event log and sequence assignment (T-14, Tech Spec §4.4).
 *
 * Rules:
 * - `seq` is monotonic per match, starting at 1 and contiguous;
 * - one action may produce more than one event, all in one persist call and
 *   one acknowledgement;
 * - each event needs its own `txId` because of the unique `{ matchId, txId }`
 *   index: the first event keeps the action txId, later events use
 *   `${actionTxId}:${seq}`;
 * - ticks never produce events and never advance `version`;
 * - there is no timeout event type in the MVP (B-03).
 */

import type { EventActor, EventType, MatchEventPayload } from '@skoriva/shared';
import { EVENT_TYPES } from '../models/enums.js';
import type { NewMatchEvent } from '../repositories/match.repo.js';
import type { BuildEventLogInput, EventLogBuilder } from './match.service.js';
import { assertTxIdFits, deriveEventTxId } from './match.service.js';

export const LIFECYCLE_EVENT_TYPES = [
  'match.create',
  'match.start',
  'match.finish',
  'match.cancel',
  'match.reopen',
  'result.save',
  'result.discard',
  'result.restore',
  'result.correct',
] as const satisfies readonly EventType[];

export const OPERATIONAL_EVENT_TYPES = [
  'score.change',
  'clock.start',
  'clock.pause',
  'clock.resume',
  'clock.reset',
  'clock.confirm',
  'period.next',
  'period.prev',
  'shotClock.reset',
  'shotClock.expired',
  'possession.set',
  'foul.add',
  'card.add',
  'match.undo',
  'badminton.serve.change',
  'badminton.interval',
  'badminton.changeEnds',
] as const satisfies readonly EventType[];

export const ACCESS_EVENT_TYPES = [
  'operator.handover',
  'operator.tokenRotate',
] as const satisfies readonly EventType[];

export const CONTEXT_EVENT_TYPES = ['context.update'] as const satisfies readonly EventType[];

const KNOWN_EVENT_TYPES = new Set<string>(EVENT_TYPES);

export class EventLogError extends Error {
  constructor(
    readonly code: 'UNKNOWN_EVENT_TYPE' | 'INVALID_SEQUENCE' | 'EMPTY_EVENT_LOG',
    message: string,
  ) {
    super(message);
    this.name = 'EventLogError';
  }
}

export function isKnownEventType(type: string): type is EventType {
  return KNOWN_EVENT_TYPES.has(type);
}

export function assertKnownEventType(type: string): asserts type is EventType {
  if (!isKnownEventType(type)) {
    throw new EventLogError('UNKNOWN_EVENT_TYPE', `Unknown event type: ${type}.`);
  }
}

/** The MVP has no timeout event; this guard documents and enforces that. */
export function assertNoTimeoutEvent(type: string): void {
  if (type === 'timeout' || type.startsWith('timeout.')) {
    throw new EventLogError('UNKNOWN_EVENT_TYPE', 'Timeout events are not part of the MVP.');
  }
}

export function isLifecycleEventType(type: EventType): boolean {
  return (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type);
}

export function isOperationalEventType(type: EventType): boolean {
  return (OPERATIONAL_EVENT_TYPES as readonly string[]).includes(type);
}

export function isAccessEventType(type: EventType): boolean {
  return (ACCESS_EVENT_TYPES as readonly string[]).includes(type);
}

export function isContextEventType(type: EventType): boolean {
  return (CONTEXT_EVENT_TYPES as readonly string[]).includes(type);
}

/** Next contiguous sequence numbers for `count` events. */
export function nextSequence(maxSeq: number, count: number): number[] {
  if (!Number.isInteger(maxSeq) || maxSeq < 0) {
    throw new EventLogError('INVALID_SEQUENCE', 'maxSeq must be a non-negative integer.');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new EventLogError('INVALID_SEQUENCE', 'count must be a positive integer.');
  }

  return Array.from({ length: count }, (_, index) => maxSeq + index + 1);
}

/**
 * Build the event rows for one action. The caller persists all rows in one
 * `persistEventsAndState` call, so a multi-event action is one transaction and
 * one acknowledgement.
 */
export function buildEventLog(input: BuildEventLogInput): NewMatchEvent[] {
  const emitted = input.emitted.length > 0 ? input.emitted : [input.action.type as EventType];

  if (emitted.length === 0) {
    throw new EventLogError('EMPTY_EVENT_LOG', 'An action must produce at least one event.');
  }

  const sequences = nextSequence(input.maxSeq, emitted.length);

  return emitted.map((type, index) => {
    assertNoTimeoutEvent(type);
    assertKnownEventType(type);

    const seq = sequences[index]!;
    const txId = deriveEventTxId(input.action.txId, seq, index);
    assertTxIdFits(txId);

    return {
      seq,
      txId,
      type,
      payload: input.action.payload as MatchEventPayload,
      actor: input.actor,
      serverTs: input.now,
      appliedAt: input.now,
    };
  });
}

/** Build a single non-action event (lifecycle, access, context). */
export function buildSingleEvent(input: {
  seq: number;
  txId: string;
  type: EventType;
  payload: MatchEventPayload;
  actor: EventActor;
  now: Date;
}): NewMatchEvent {
  assertNoTimeoutEvent(input.type);
  assertKnownEventType(input.type);
  assertTxIdFits(input.txId);

  return {
    seq: input.seq,
    txId: input.txId,
    type: input.type,
    payload: input.payload,
    actor: input.actor,
    serverTs: input.now,
    appliedAt: input.now,
  };
}

/** T-12 `EventLogBuilder` implementation. */
export const eventLogBuilder: EventLogBuilder = {
  build: buildEventLog,
};
