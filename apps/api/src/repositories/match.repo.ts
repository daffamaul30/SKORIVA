/**
 * Match repository (T-08).
 *
 * Persistence pattern:
 *   1. append match events first (unique `{ matchId, seq }` and `{ matchId, txId }`);
 *   2. conditionally update `matches.state` with `state.version < newVersion`.
 *
 * There is no MongoDB transaction. If state update fails after events were
 * written, the events are kept and the caller can reload/replay. No event or
 * state write happens per clock tick.
 *
 * Important: the unique `{ matchId, txId }` index means each event needs its
 * own unique `txId`. An action that produces multiple events must derive a
 * distinct txId for each event (for example, the action txId plus a suffix).
 * This is enforced here so the write cannot silently fail.
 *
 * This is a data-access layer only. Lifecycle guards, sport reducers, access
 * checks, and the action pipeline belong to later tasks.
 */

import { MatchEventModel, MatchModel } from '../models/index.js';
import { isMetaEventType } from '../models/index.js';
import type { MatchDocument, MatchEventDocument } from '../models/index.js';
import type { EventActor, EventType, MatchEventPayload, MatchState } from '@skoriva/shared';

export interface NewMatchEvent {
  seq: number;
  /**
   * Per-event idempotency key. The unique `{ matchId, txId }` index means a
   * multi-event action must derive a distinct txId for each event upstream.
   */
  txId: string;
  type: EventType;
  payload: MatchEventPayload;
  actor: EventActor;
  serverTs: Date;
  appliedAt: Date;
}

export type MatchLifecyclePatch = Partial<
  Pick<
    MatchDocument,
    | 'matchStatus'
    | 'resultDecision'
    | 'startedAt'
    | 'finishedAt'
    | 'activeOperatorId'
    | 'operatorGraceUntil'
  >
> & {
  /** Reopen clears the current finish timestamp; history stays in the event log. */
  clearFinishedAt?: boolean;
};

const MATCH_PATCH_ALLOWLIST = [
  'matchStatus',
  'resultDecision',
  'startedAt',
  'finishedAt',
  'activeOperatorId',
  'operatorGraceUntil',
] as const satisfies readonly (keyof MatchLifecyclePatch)[];

export type MatchMetadataPatch = Partial<Pick<MatchDocument, 'teams' | 'config' | 'context'>>;

const MATCH_METADATA_ALLOWLIST = [
  'teams',
  'config',
  'context',
] as const satisfies readonly (keyof MatchMetadataPatch)[];

function sanitizeMetadataPatch(patch: MatchMetadataPatch): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const key of MATCH_METADATA_ALLOWLIST) {
    const value = patch[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export type CreateMatchInput = Omit<MatchDocument, '_id' | 'createdAt' | 'updatedAt'>;

export interface LoadedMatchWithEvents {
  match: MatchDocument;
  events: MatchEventDocument[];
  /** Last sequence across all events, including meta events. */
  lastSeq: number;
  /** Last sequence of an event that changes state (meta events excluded). */
  lastStateAffectingSeq: number;
  /** Backward-compatible alias for `lastSeq`. */
  maxSeq: number;
  needsReplay: boolean;
}

export type AppendEventsResult =
  | { status: 'inserted'; events: MatchEventDocument[] }
  | { status: 'duplicate_tx'; events: MatchEventDocument[] }
  | { status: 'match_not_found'; events: [] };

export type PersistEventsAndStateResult =
  | { status: 'committed'; events: MatchEventDocument[] }
  | { status: 'duplicate_tx'; events: MatchEventDocument[] }
  | { status: 'state_conflict'; events: MatchEventDocument[] }
  | { status: 'state_update_failed'; events: MatchEventDocument[]; error: unknown }
  | { status: 'match_not_found'; events: [] };

export type ReplayMatchStateFn = (
  baseState: MatchState,
  events: readonly MatchEventDocument[],
) => MatchState;

export type ReplayMatchStateResult =
  | { status: 'in_sync'; match: MatchDocument; events: MatchEventDocument[]; maxSeq: number }
  | { status: 'replayed'; match: MatchDocument; events: MatchEventDocument[]; maxSeq: number }
  | { status: 'state_conflict'; match: MatchDocument; events: MatchEventDocument[]; maxSeq: number }
  | { status: 'match_not_found' };

export class EventSequenceConflictError extends Error {
  readonly code = 'EVENT_SEQUENCE_CONFLICT';

  constructor(
    readonly matchId: string,
    readonly seq: number,
  ) {
    super(`Event sequence ${seq} already exists for match ${matchId}.`);
    this.name = 'EventSequenceConflictError';
  }
}

interface DuplicateKeyDetails {
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  message?: string;
  operation?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function getDuplicateKeyDetails(error: unknown): DuplicateKeyDetails | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    keyPattern?: unknown;
    keyValue?: unknown;
    writeErrors?: Array<{
      err?: {
        code?: unknown;
        errmsg?: unknown;
        keyPattern?: unknown;
        keyValue?: unknown;
        op?: unknown;
      };
    }>;
  };

  const writeError = candidate.writeErrors?.[0]?.err;
  const code = candidate.code ?? writeError?.code;

  if (code !== 11000) return null;

  return {
    keyPattern: asRecord(candidate.keyPattern) ?? asRecord(writeError?.keyPattern),
    keyValue: asRecord(candidate.keyValue) ?? asRecord(writeError?.keyValue),
    message:
      typeof writeError?.errmsg === 'string'
        ? writeError.errmsg
        : typeof candidate.message === 'string'
          ? candidate.message
          : undefined,
    operation: asRecord(writeError?.op),
  };
}

function sanitizeMatchPatch(patch: MatchLifecyclePatch | undefined): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  if (!patch) return sanitized;

  for (const key of MATCH_PATCH_ALLOWLIST) {
    const value = patch[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export async function createMatch(input: CreateMatchInput): Promise<MatchDocument> {
  const document = await MatchModel.create(input);
  return document.toObject() as MatchDocument;
}

/**
 * Metadata update for PATCH /api/matches/:id. The `matchStatus: 'ready'` filter
 * makes the LC-02 lock atomic with concurrent lifecycle actions.
 */
export async function updateMatchMetadata(
  matchId: string,
  patch: MatchMetadataPatch,
): Promise<MatchDocument | null> {
  const update = sanitizeMetadataPatch(patch);

  if (Object.keys(update).length === 0) {
    return findMatchById(matchId);
  }

  return MatchModel.findOneAndUpdate(
    { _id: matchId, matchStatus: 'ready' },
    { $set: update },
    { new: true, runValidators: true },
  )
    .lean<MatchDocument>()
    .exec();
}

/** Claim a device-owned match for an account (T-29). */
export async function claimMatchOwner(
  matchId: string,
  accountId: string,
): Promise<MatchDocument | null> {
  return MatchModel.findOneAndUpdate(
    { _id: matchId, 'owner.type': 'device' },
    { $set: { owner: { type: 'account', id: accountId } } },
    { new: true, runValidators: true },
  )
    .lean<MatchDocument>()
    .exec();
}

/** Rollback helper for a failed create (the match was just created). */
export async function deleteMatchById(matchId: string): Promise<void> {
  await MatchModel.deleteOne({ _id: matchId }).exec();
}

export async function findMatchById(matchId: string): Promise<MatchDocument | null> {
  return MatchModel.findById(matchId).lean<MatchDocument>().exec();
}

export async function findMatchEvents(matchId: string): Promise<MatchEventDocument[]> {
  return MatchEventModel.find({ matchId }).sort({ seq: 1 }).lean<MatchEventDocument[]>().exec();
}

export const listMatchEvents = findMatchEvents;

/** Load the materialized match together with its append-only event log. */
export async function loadMatchWithEvents(matchId: string): Promise<LoadedMatchWithEvents | null> {
  const [match, events] = await Promise.all([findMatchById(matchId), findMatchEvents(matchId)]);

  if (!match) return null;

  const lastEvent = events[events.length - 1];
  const lastSeq = lastEvent?.seq ?? 0;

  // Meta events (currently `match.create`) consume sequence numbers but never
  // change the materialized state. Replay is needed only when the snapshot is
  // behind the last state-affecting event.
  const lastStateAffecting = [...events].reverse().find((event) => !isMetaEventType(event.type));
  const lastStateAffectingSeq = lastStateAffecting?.seq ?? 0;

  return {
    match,
    events,
    lastSeq,
    lastStateAffectingSeq,
    maxSeq: lastSeq,
    needsReplay: match.state.version < lastStateAffectingSeq,
  };
}

/**
 * Update the materialized state only if the stored version is older than the
 * incoming version. `matchPatch` is restricted to the lifecycle allowlist; it
 * cannot overwrite state, version, score, or sport state.
 */
export async function updateMatchStateConditional(
  matchId: string,
  state: MatchState,
  matchPatch?: MatchLifecyclePatch,
): Promise<{ applied: boolean; matchedCount: number }> {
  const update: Record<string, unknown> = {
    state,
    ...sanitizeMatchPatch(matchPatch),
  };
  const unset: Record<string, ''> = {};

  if (matchPatch?.clearFinishedAt) {
    unset.finishedAt = '';
  }

  const result = await MatchModel.updateOne(
    { _id: matchId, 'state.version': { $lt: state.version } },
    Object.keys(unset).length > 0 ? { $set: update, $unset: unset } : { $set: update },
    { runValidators: true },
  );

  return { applied: result.matchedCount === 1, matchedCount: result.matchedCount };
}

async function findEventsByTxIds(matchId: string, txIds: string[]): Promise<MatchEventDocument[]> {
  return MatchEventModel.find({ matchId, txId: { $in: txIds } })
    .sort({ seq: 1 })
    .lean<MatchEventDocument[]>()
    .exec();
}

/**
 * Append events for one action. Each event must carry a unique `txId` because
 * of the unique `{ matchId, txId }` index; multi-event actions derive distinct
 * per-event txIds upstream.
 *
 * Duplicate `txId` is idempotent and returns the existing events. Duplicate
 * `seq` is a real conflict and throws a typed error.
 */
export async function appendEvents(
  matchId: string,
  events: NewMatchEvent[],
): Promise<AppendEventsResult> {
  if (events.length === 0) {
    throw new Error('At least one event is required.');
  }

  const txIds = [...new Set(events.map((event) => event.txId))];
  if (txIds.length !== events.length) {
    throw new Error('Each event in one append must have a unique txId.');
  }

  const matchExists = await MatchModel.exists({ _id: matchId });
  if (!matchExists) {
    return { status: 'match_not_found', events: [] };
  }

  // Fast idempotency path before hitting the unique index.
  const existing = await findEventsByTxIds(matchId, txIds);
  if (existing.length > 0) {
    return { status: 'duplicate_tx', events: existing };
  }

  try {
    const inserted = await MatchEventModel.insertMany(
      events.map((event) => ({ matchId, ...event })),
      { ordered: true },
    );

    return {
      status: 'inserted',
      events: inserted.map((document) => document.toObject() as MatchEventDocument),
    };
  } catch (error) {
    const duplicate = getDuplicateKeyDetails(error);

    if (duplicate) {
      const message = duplicate.message ?? '';
      const txIdDuplicate =
        (duplicate.keyPattern !== undefined && 'txId' in duplicate.keyPattern) ||
        message.includes('matchId_1_txId_1');
      const seqDuplicate =
        (duplicate.keyPattern !== undefined && 'seq' in duplicate.keyPattern) ||
        message.includes('matchId_1_seq_1');

      // Race: another request inserted the same txId after our pre-check.
      if (txIdDuplicate) {
        const raced = await findEventsByTxIds(matchId, txIds);
        return { status: 'duplicate_tx', events: raced };
      }

      // A duplicate seq means the caller's sequence is stale; keep the
      // already-written events and let the caller reload/replay.
      if (seqDuplicate) {
        const seq = Number(
          duplicate.keyValue?.seq ?? duplicate.operation?.seq ?? events[0]?.seq ?? 0,
        );
        throw new EventSequenceConflictError(matchId, seq);
      }
    }

    throw error;
  }
}

/**
 * Persist events first, then conditionally materialize the new state.
 *
 * If the state update fails, the inserted events are intentionally kept.
 * Returning a structured result lets the caller reload and replay.
 */
export async function persistEventsAndState(input: {
  matchId: string;
  events: NewMatchEvent[];
  state: MatchState;
  matchPatch?: MatchLifecyclePatch;
}): Promise<PersistEventsAndStateResult> {
  const appended = await appendEvents(input.matchId, input.events);

  if (appended.status === 'match_not_found') {
    return { status: 'match_not_found', events: [] };
  }

  if (appended.status === 'duplicate_tx') {
    return { status: 'duplicate_tx', events: appended.events };
  }

  try {
    const update = await updateMatchStateConditional(input.matchId, input.state, input.matchPatch);

    if (!update.applied) {
      return { status: 'state_conflict', events: appended.events };
    }

    return { status: 'committed', events: appended.events };
  } catch (error) {
    // Events are already durable; never delete them here.
    return { status: 'state_update_failed', events: appended.events, error };
  }
}

/**
 * Repository-level self-healing hook. The actual fold/reducer is supplied by
 * T-15/T-12; T-08 only persists the replayed state conditionally.
 */
export async function replayMatchState(
  matchId: string,
  replay: ReplayMatchStateFn,
): Promise<ReplayMatchStateResult> {
  const loaded = await loadMatchWithEvents(matchId);

  if (!loaded) {
    return { status: 'match_not_found' };
  }

  if (!loaded.needsReplay) {
    return {
      status: 'in_sync',
      match: loaded.match,
      events: loaded.events,
      maxSeq: loaded.maxSeq,
    };
  }

  const replayedState = replay(loaded.match.state, loaded.events);
  const update = await updateMatchStateConditional(matchId, replayedState);

  if (!update.applied) {
    return {
      status: 'state_conflict',
      match: loaded.match,
      events: loaded.events,
      maxSeq: loaded.maxSeq,
    };
  }

  return {
    status: 'replayed',
    match: { ...loaded.match, state: replayedState },
    events: loaded.events,
    maxSeq: loaded.maxSeq,
  };
}

export async function countMatchesForEvent(eventId: string): Promise<number> {
  return MatchModel.countDocuments({ 'context.eventId': eventId });
}

/**
 * Matches visible on an event page (T-30, FR-25):
 * READY, LIVE, or FINISHED with a saved result. Undecided/discarded/cancelled
 * matches are intentionally excluded.
 */
export async function findMatchesForEvent(eventId: string): Promise<MatchDocument[]> {
  return MatchModel.find({
    'context.eventId': eventId,
    $or: [
      { matchStatus: { $in: ['ready', 'live'] } },
      { matchStatus: 'finished', resultDecision: 'saved' },
    ],
  })
    .lean<MatchDocument[]>()
    .exec();
}
