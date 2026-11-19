/**
 * Append-only match event log types (Tech Spec §2.3 `matchEvents`, §4.4).
 *
 * Rules:
 * - No updates and no deletes (BR-09).
 * - `seq` is monotonic per match starting at 1; `txId` provides idempotency.
 * - Ticks never produce events and never advance `version`.
 * - **No timeout event type exists in the MVP** (B-03 / BR-21).
 */

export const EVENT_TYPES = [
  // Lifecycle
  'match.create',
  'match.start',
  'match.finish',
  'match.cancel',
  'match.reopen',
  'result.save',
  'result.discard',
  'result.restore',
  'result.correct',
  // Operational
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
  // Badminton (BWF)
  'badminton.serve.change',
  'badminton.interval',
  'badminton.changeEnds',
  // Access
  'operator.handover',
  'operator.tokenRotate',
  // Context
  'context.update',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ACTOR_TYPES = ['operator', 'system', 'account'] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface EventActor {
  type: ActorType;
  id?: string;
}

/**
 * Event payloads are sport-additive. `playerId` is reserved for a possible
 * future roster feature so that adding it later does not require a destructive
 * migration (Tech Spec §2.2).
 */
export interface MatchEventPayload {
  [key: string]: unknown;
  playerId?: string;
}

/** One append-only row in the `matchEvents` collection. */
export interface MatchEventRecord<TPayload extends MatchEventPayload = MatchEventPayload> {
  id: string;
  matchId: string;
  seq: number;
  /** Idempotency key. MVP technical limit: 128 characters (see `TEXT_LIMITS.txId`). */
  txId: string;
  type: EventType;
  payload: TPayload;
  actor: EventActor;
  serverTs: Date;
  appliedAt: Date;
}
