/**
 * Operational match actions (Tech Spec §3.3, §4.4).
 *
 * Actions are *operational* only: lifecycle transitions travel over REST
 * (B-06), while scores, clocks, periods and sport actions travel over
 * Socket.IO and still go through the same pipeline.
 *
 * - **No timeout action exists in the MVP** (B-03 / BR-21).
 * - Badminton has no direct decrement action; point corrections use Undo
 *   (FIX-04). Volleyball decrement is validated by the engine (FR-06).
 */

import type { TeamSide } from './team.js';

/** Every operational action carries idempotency and concurrency guards. */
export interface MatchActionEnvelope<TPayload = unknown> {
  txId: string;
  expectedVersion: number;
  payload: TPayload;
}

export type PenaltyCard = 'yellow' | 'red';

export interface ScoreChangePayload {
  side: TeamSide;
  points: number;
}

export interface ClockPayload {
  /** Optional explicit remaining time in milliseconds. */
  remainingMs?: number;
}

export interface ClockConfirmPayload {
  /** Operator-acknowledged remaining time after recovery (B-11). */
  remainingMs?: number;
}

export interface BadmintonServeChangePayload {
  side: TeamSide;
}

export interface UndoPayload {
  /** Sequence number of the event to remove from the fold. */
  targetSeq: number;
}

/** Discriminated union of all operational actions. */
export type MatchAction =
  | { type: 'score.change'; payload: ScoreChangePayload }
  | { type: 'clock.start'; payload: ClockPayload }
  | { type: 'clock.pause'; payload: ClockPayload }
  | { type: 'clock.resume'; payload: ClockPayload }
  | { type: 'clock.reset'; payload: ClockPayload }
  | { type: 'clock.confirm'; payload: ClockConfirmPayload }
  | { type: 'period.next'; payload: Record<string, never> }
  // `period.prev` is marker-only with guard and only valid for Basketball/Futsal (B-01).
  | { type: 'period.prev'; payload: Record<string, never> }
  | { type: 'shotClock.reset'; payload: Record<string, never> }
  | { type: 'possession.set'; payload: { side: TeamSide } }
  | { type: 'foul.add'; payload: { side: TeamSide } }
  | { type: 'card.add'; payload: { side: TeamSide; card: PenaltyCard } }
  | { type: 'badminton.serve.change'; payload: BadmintonServeChangePayload }
  | { type: 'badminton.interval'; payload: { action: 'start' | 'end' } }
  | { type: 'badminton.changeEnds'; payload: Record<string, never> }
  | { type: 'match.undo'; payload: UndoPayload };

export type MatchActionType = MatchAction['type'];

/**
 * The subset of event types that may be created from an operational action.
 * Lifecycle and access events are produced by their own flows.
 */
export const OPERATIONAL_ACTION_TYPES = [
  'score.change',
  'clock.start',
  'clock.pause',
  'clock.resume',
  'clock.reset',
  'clock.confirm',
  'period.next',
  'period.prev',
  'shotClock.reset',
  'possession.set',
  'foul.add',
  'card.add',
  'badminton.serve.change',
  'badminton.interval',
  'badminton.changeEnds',
  'match.undo',
] as const;

export type OperationalActionType = (typeof OPERATIONAL_ACTION_TYPES)[number];
