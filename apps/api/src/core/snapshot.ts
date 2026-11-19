/**
 * Snapshot and deterministic replay (T-15).
 *
 * The materialized state in `matches.state` is a snapshot at `state.version`,
 * which always equals the last applied event `seq`. Replay folds the append-only
 * log on top of a snapshot:
 *
 *   fold(snapshot, events where seq > snapshot.version) → state
 *
 * The folder is injected. This keeps core independent of sport engines; T-19
 * supplies a `SportEngine` adapter and T-16 supplies the clock folder.
 *
 * A half-successful write (events durable, state update failed) is repaired by
 * replaying the missing events. Events are applied in strict seq order; a gap
 * is a real inconsistency and fails loudly instead of silently skipping.
 */

import type {
  EventType,
  MatchAction,
  MatchEventPayload,
  MatchState,
  ReduceResult,
  SportState,
} from '@skoriva/shared';
import type { ReplayMatchStateFn } from '../repositories/match.repo.js';
import { replayMatchState } from '../repositories/match.repo.js';
import type { ReplayMatchStateResult } from '../repositories/match.repo.js';
import { isOperationalEventType } from './event-log.js';
import { isMetaEventType } from '../models/enums.js';

/** Minimal event shape needed for folding; full documents are assignable. */
export interface ReplayableEvent {
  seq: number;
  type: EventType;
  payload: MatchEventPayload;
  serverTs: Date;
}

export type EventFolder = (state: MatchState, event: ReplayableEvent) => MatchState;

export type SnapshotErrorCode = 'SEQUENCE_GAP' | 'INVALID_SEQUENCE' | 'REPLAY_REDUCE_FAILED';

export class SnapshotError extends Error {
  constructor(
    readonly code: SnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** True when the materialized snapshot already covers every state-affecting event. */
export function isSnapshotInSync(state: MatchState, lastStateAffectingSeq: number): boolean {
  return state.version >= lastStateAffectingSeq;
}

/** Events that still need to be folded on top of the snapshot. */
export function pendingEvents(
  state: MatchState,
  events: readonly ReplayableEvent[],
): ReplayableEvent[] {
  return events
    .filter((event) => event.seq > state.version)
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Fold pending events in strict sequence order. Meta events (for example
 * `match.create`) consume a sequence number but do not change state or
 * `state.version`. The resulting version is the last state-affecting `seq`.
 */
export function foldEvents(
  baseState: MatchState,
  events: readonly ReplayableEvent[],
  folder: EventFolder,
): MatchState {
  const pending = pendingEvents(baseState, events);

  if (pending.length === 0) return { ...baseState, sportState: baseState.sportState ?? {} };

  let state: MatchState = { ...baseState, sportState: baseState.sportState ?? {} };
  let expectedSeq = baseState.version + 1;

  for (const event of pending) {
    if (event.seq !== expectedSeq) {
      throw new SnapshotError(
        'SEQUENCE_GAP',
        `Expected event seq ${expectedSeq} but found ${event.seq}.`,
      );
    }

    if (isMetaEventType(event.type)) {
      expectedSeq += 1;
      continue;
    }

    state = folder(state, event);
    state = { ...state, version: event.seq };
    expectedSeq += 1;
  }

  return state;
}

/** Fold function suitable for the T-08 repository replay injection. */
export function createReplayFn(folder: EventFolder): ReplayMatchStateFn {
  return (baseState, events) => foldEvents(baseState, events, folder);
}

/**
 * Replay and persist a match snapshot using the repository's self-healing hook.
 * This is what the runtime registry calls when it hydrates a stale match.
 */
export async function replayMatchSnapshot(
  matchId: string,
  folder: EventFolder,
): Promise<ReplayMatchStateResult> {
  return replayMatchState(matchId, createReplayFn(folder));
}

/** Compose multiple folders; each receives the state produced by the previous. */
export function composeFolders(...folders: EventFolder[]): EventFolder {
  return (state, event) => folders.reduce((current, folder) => folder(current, event), state);
}

const ACTION_EVENT_TYPES = new Set<string>([
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
]);

/** Convert an operational event back into the action shape a sport engine expects. */
export function eventToAction(event: ReplayableEvent): MatchAction | null {
  if (!isOperationalEventType(event.type) || !ACTION_EVENT_TYPES.has(event.type)) {
    return null;
  }

  return {
    type: event.type,
    payload: event.payload ?? {},
  } as MatchAction;
}

export interface SportReducerLike {
  reduce(state: SportState, action: MatchAction): ReduceResult<SportState>;
}

/**
 * Adapter from the shared `SportEngine.reduce` contract to a replay folder.
 * Only `sportState` is reduced; clock/period remain owned by their folders.
 *
 * No engine exists in Batch 1 (T-20…T-23); this adapter is the integration
 * point for the sport-engine batch.
 */
export function createSportEngineFolder(engine: SportReducerLike): EventFolder {
  return (state, event) => {
    const action = eventToAction(event);

    if (!action) return state;

    const reduced = engine.reduce(state.sportState as SportState, action);

    if (!reduced.ok) {
      throw new SnapshotError(
        'REPLAY_REDUCE_FAILED',
        `Replay failed for event seq ${event.seq}: ${reduced.code}.`,
      );
    }

    return { ...state, sportState: reduced.state };
  };
}
