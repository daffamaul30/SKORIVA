/**
 * Runtime enum values for Mongoose schemas (T-07).
 *
 * Why local arrays instead of importing values from `@skoriva/shared`:
 * the shared package exports TypeScript sources with `.js` specifiers, which
 * Node cannot execute directly from the compiled API. Type-only imports from
 * `@skoriva/shared` are safe (they are erased at compile time) and are used to
 * keep these arrays aligned with the domain types. `schema.test.ts` also does
 * a runtime parity check against the shared values under Vitest.
 */

import type {
  ActorType,
  EventType,
  MatchStatus,
  PeriodStatus,
  ResultDecision,
  Sport,
} from '@skoriva/shared';

export const SPORTS = [
  'basketball',
  'futsal',
  'badminton',
  'volleyball',
] as const satisfies readonly Sport[];

export const MATCH_STATUSES = [
  'ready',
  'live',
  'finished',
  'cancelled',
] as const satisfies readonly MatchStatus[];

export const RESULT_DECISIONS = [
  'undecided',
  'saved',
  'discarded',
] as const satisfies readonly ResultDecision[];

export const PERIOD_STATUSES = [
  'pending',
  'active',
  'complete',
] as const satisfies readonly PeriodStatus[];

export const ACTOR_TYPES = [
  'operator',
  'system',
  'account',
] as const satisfies readonly ActorType[];

export const EVENT_TYPES = [
  'match.create',
  'match.start',
  'match.finish',
  'match.cancel',
  'match.reopen',
  'result.save',
  'result.discard',
  'result.restore',
  'result.correct',
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
  'operator.handover',
  'operator.tokenRotate',
  'context.update',
] as const satisfies readonly EventType[];

export const GAME_CLOCK_MODES = ['timed', 'none'] as const;
export const OWNER_TYPES = ['device', 'account'] as const;

/**
 * Meta events are part of the append-only log and consume a sequence number,
 * but do not change the materialized state or `state.version`.
 *
 * `match.create` is recorded at creation while the snapshot stays at v0.
 */
export const META_EVENT_TYPES = ['match.create'] as const;

export type MetaEventType = (typeof META_EVENT_TYPES)[number];

export function isMetaEventType(type: string): boolean {
  return (META_EVENT_TYPES as readonly string[]).includes(type);
}
