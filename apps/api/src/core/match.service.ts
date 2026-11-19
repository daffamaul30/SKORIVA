/**
 * Match action pipeline (T-12).
 *
 * Order (Tech Spec §4.1):
 *   authorize → load runtime → idempotency (txId) → expectedVersion guard →
 *   lifecycle validation → reduce → persist → ack.
 *
 * The pipeline is deliberately dependency-injected so that later, separately
 * tracked tasks can plug in without circular imports:
 * - T-13 lifecycle guard;
 * - T-14 event log / sequence;
 * - T-15 deterministic replay;
 * - T-16 clock reducer;
 * - T-19 sport engine reducer.
 *
 * T-08 remains a data-access layer. If a state update conflicts, the pipeline
 * reloads events, replays, and returns a structured result. It never retries
 * the failed action automatically.
 */

import type { EventActor, EventType, MatchAction, MatchState } from '@skoriva/shared';
import { env } from '../config/env.js';
import { MatchEventModel } from '../models/index.js';
import type { MatchDocument, MatchEventDocument } from '../models/index.js';
import {
  loadMatchWithEvents,
  persistEventsAndState,
  replayMatchState,
} from '../repositories/match.repo.js';
import type {
  LoadedMatchWithEvents,
  NewMatchEvent,
  PersistEventsAndStateResult,
  ReplayMatchStateFn,
  ReplayMatchStateResult,
} from '../repositories/match.repo.js';
import { verifyOperatorSession } from '../access/operator-session.js';
import { matchQueue } from './match-queue.js';
import type { SerialQueue } from './match-queue.js';

export type DispatchAction = MatchAction & {
  txId: string;
  expectedVersion: number;
};

export interface DispatchContext {
  /** Plaintext operator credential from `X-Operator-Session`. */
  operatorCredential?: string;
  actor: EventActor;
  now?: Date;
}

export interface ReduceOutcome {
  /** Version may be stale; the pipeline sets the final materialized version. */
  state: MatchState;
  emitted: readonly EventType[];
}

export type StateReducer = (
  state: MatchState,
  action: DispatchAction,
  match: MatchDocument,
  now: Date,
) => ReduceOutcome;

export interface LifecycleGuard {
  assertActionAllowed(match: MatchDocument, action: DispatchAction): void;
}

export interface BuildEventLogInput {
  match: MatchDocument;
  action: DispatchAction;
  state: MatchState;
  emitted: readonly EventType[];
  maxSeq: number;
  now: Date;
  actor: EventActor;
}

export interface EventLogBuilder {
  build(input: BuildEventLogInput): NewMatchEvent[];
}

export type ReplayFn = (
  baseState: MatchState,
  events: readonly MatchEventDocument[],
  match: MatchDocument,
) => MatchState;

export type AuthorizeFn = (matchId: string, context: DispatchContext, now: Date) => Promise<void>;

export interface MatchServiceDeps {
  authorize: AuthorizeFn;
  lifecycle: LifecycleGuard;
  reduce: StateReducer;
  buildEvents: EventLogBuilder;
  replay: ReplayFn;
  loadMatch: (matchId: string) => Promise<LoadedMatchWithEvents | null>;
  persist: (input: {
    matchId: string;
    events: NewMatchEvent[];
    state: MatchState;
  }) => Promise<PersistEventsAndStateResult>;
  replayMatch: (matchId: string, replay: ReplayMatchStateFn) => Promise<ReplayMatchStateResult>;
  queue: SerialQueue;
}

export type DispatchResult =
  | {
      status: 'committed';
      version: number;
      txId: string;
      events: MatchEventDocument[];
    }
  | {
      status: 'duplicate';
      version: number;
      txId: string;
      events: MatchEventDocument[];
    }
  | {
      status: 'version_conflict';
      version: number;
      txId: string;
      snapshot: MatchState;
    }
  | {
      status: 'state_conflict' | 'state_update_failed';
      version: number;
      txId: string;
      events: MatchEventDocument[];
      snapshot: MatchState;
    };

export type MatchServiceErrorCode =
  'MATCH_NOT_FOUND' | 'INVALID_ACTION' | 'TX_ID_TOO_LONG' | 'OPERATOR_REQUIRED';

export class MatchServiceError extends Error {
  constructor(
    readonly code: MatchServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MatchServiceError';
  }
}

export const MAX_TX_ID_LENGTH = 128;

const OPERATIONAL_ACTION_TYPES = new Set<string>([
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

function assertValidAction(action: DispatchAction): void {
  if (!OPERATIONAL_ACTION_TYPES.has(action.type)) {
    throw new MatchServiceError('INVALID_ACTION', `Unsupported action type: ${action.type}.`);
  }

  if (typeof action.payload !== 'object' || action.payload === null) {
    throw new MatchServiceError('INVALID_ACTION', 'Action payload must be an object.');
  }

  if (typeof action.txId !== 'string' || action.txId.trim().length === 0) {
    throw new MatchServiceError('INVALID_ACTION', 'txId is required.');
  }

  if (action.txId.length > MAX_TX_ID_LENGTH) {
    throw new MatchServiceError(
      'TX_ID_TOO_LONG',
      `txId must be at most ${MAX_TX_ID_LENGTH} characters.`,
    );
  }

  if (!Number.isInteger(action.expectedVersion) || action.expectedVersion < 0) {
    throw new MatchServiceError(
      'INVALID_ACTION',
      'expectedVersion must be a non-negative integer.',
    );
  }
}

/**
 * Deterministic per-event txId: the first event keeps the action txId, later
 * events append their sequence number.
 */
export function deriveEventTxId(actionTxId: string, seq: number, index: number): string {
  if (index === 0) return actionTxId;
  return `${actionTxId}:${seq}`;
}

export function assertTxIdFits(txId: string): void {
  if (txId.length > MAX_TX_ID_LENGTH) {
    throw new MatchServiceError(
      'TX_ID_TOO_LONG',
      `Derived event txId exceeds ${MAX_TX_ID_LENGTH} characters.`,
    );
  }
}

export const defaultLifecycleGuard: LifecycleGuard = {
  assertActionAllowed(): void {
    // T-13 replaces this with the full PRD §3A transition matrix.
  },
};

export const defaultReducer: StateReducer = (state, action) => ({
  state,
  emitted: [action.type as EventType],
});

export const defaultEventLogBuilder: EventLogBuilder = {
  build(input): NewMatchEvent[] {
    const emitted = input.emitted.length > 0 ? input.emitted : [input.action.type as EventType];

    return emitted.map((type, index) => {
      const seq = input.maxSeq + index + 1;
      const txId = deriveEventTxId(input.action.txId, seq, index);
      assertTxIdFits(txId);

      return {
        seq,
        txId,
        type,
        payload: input.action.payload as Record<string, unknown>,
        actor: input.actor,
        serverTs: input.now,
        appliedAt: input.now,
      };
    });
  },
};

export const defaultReplay: ReplayFn = (baseState, events) => {
  const last = events[events.length - 1];
  return last ? { ...baseState, version: last.seq } : baseState;
};

export async function defaultAuthorize(
  matchId: string,
  context: DispatchContext,
  now: Date,
): Promise<void> {
  if (!context.operatorCredential) {
    throw new MatchServiceError(
      'OPERATOR_REQUIRED',
      'An active operator session is required for this action.',
    );
  }

  await verifyOperatorSession(matchId, context.operatorCredential, env.TOKEN_PEPPER, now);
}

function createDefaultDeps(): MatchServiceDeps {
  return {
    authorize: defaultAuthorize,
    lifecycle: defaultLifecycleGuard,
    reduce: defaultReducer,
    buildEvents: defaultEventLogBuilder,
    replay: defaultReplay,
    loadMatch: loadMatchWithEvents,
    persist: ({ matchId, events, state }) => persistEventsAndState({ matchId, events, state }),
    replayMatch: replayMatchState,
    queue: matchQueue,
  };
}

function findEventByTxId(
  events: readonly MatchEventDocument[],
  txId: string,
): MatchEventDocument | undefined {
  return events.find((event) => event.txId === txId);
}

export class MatchService {
  private readonly deps: MatchServiceDeps;

  constructor(overrides: Partial<MatchServiceDeps> = {}) {
    this.deps = { ...createDefaultDeps(), ...overrides };
  }

  /**
   * Dispatch one operational action through the serial per-match queue.
   * Idempotency is checked before the version guard.
   */
  async dispatch(
    matchId: string,
    action: DispatchAction,
    context: DispatchContext,
  ): Promise<DispatchResult> {
    assertValidAction(action);

    return this.deps.queue.run(matchId, async () => {
      const now = context.now ?? new Date();
      await this.deps.authorize(matchId, context, now);

      let loaded = await this.deps.loadMatch(matchId);
      if (!loaded) {
        throw new MatchServiceError('MATCH_NOT_FOUND', 'Match not found.');
      }

      if (loaded.needsReplay) {
        loaded = await this.refreshAfterReplay(matchId, loaded);
      }

      const duplicate = findEventByTxId(loaded.events, action.txId);
      if (duplicate) {
        return {
          status: 'duplicate' as const,
          version: loaded.match.state.version,
          txId: action.txId,
          events: loaded.events,
        };
      }

      if (action.expectedVersion !== loaded.match.state.version) {
        return {
          status: 'version_conflict' as const,
          version: loaded.match.state.version,
          txId: action.txId,
          snapshot: loaded.match.state,
        };
      }

      this.deps.lifecycle.assertActionAllowed(loaded.match, action);

      const reduced = this.deps.reduce(loaded.match.state, action, loaded.match, now);
      const events = this.deps.buildEvents.build({
        match: loaded.match,
        action,
        state: reduced.state,
        emitted: reduced.emitted,
        maxSeq: loaded.maxSeq,
        now,
        actor: context.actor,
      });

      if (events.length === 0) {
        throw new MatchServiceError('INVALID_ACTION', 'Action produced no events.');
      }

      const finalVersion = loaded.maxSeq + events.length;
      const newState: MatchState = { ...reduced.state, version: finalVersion };

      const persisted = await this.deps.persist({ matchId, events, state: newState });

      if (persisted.status === 'match_not_found') {
        throw new MatchServiceError('MATCH_NOT_FOUND', 'Match not found.');
      }

      if (persisted.status === 'duplicate_tx') {
        const current = await this.refreshAfterReplay(matchId, await this.requireLoaded(matchId));

        return {
          status: 'duplicate' as const,
          version: current.match.state.version,
          txId: action.txId,
          events: current.events,
        };
      }

      if (persisted.status === 'committed') {
        return {
          status: 'committed' as const,
          version: finalVersion,
          txId: action.txId,
          events: persisted.events,
        };
      }

      // state_conflict / state_update_failed: events stay durable. Reload and
      // replay to repair the runtime state, then return a structured result.
      // The failed action is never retried automatically.
      const repaired = await this.requireLoaded(matchId);
      const refreshed = await this.refreshAfterReplay(matchId, repaired);

      return {
        status: persisted.status,
        version: refreshed.match.state.version,
        txId: action.txId,
        events: persisted.events,
        snapshot: refreshed.match.state,
      };
    });
  }

  private async requireLoaded(matchId: string): Promise<LoadedMatchWithEvents> {
    const loaded = await this.deps.loadMatch(matchId);

    if (!loaded) {
      throw new MatchServiceError('MATCH_NOT_FOUND', 'Match not found.');
    }

    return loaded;
  }

  private async refreshAfterReplay(
    matchId: string,
    current: LoadedMatchWithEvents,
  ): Promise<LoadedMatchWithEvents> {
    if (!current.needsReplay) return current;

    const replayed = await this.deps.replayMatch(matchId, (baseState, events) =>
      this.deps.replay(baseState, events, current.match),
    );

    if (replayed.status === 'match_not_found') {
      throw new MatchServiceError('MATCH_NOT_FOUND', 'Match not found.');
    }

    const loaded = await this.deps.loadMatch(matchId);

    if (!loaded) {
      throw new MatchServiceError('MATCH_NOT_FOUND', 'Match not found.');
    }

    return loaded;
  }
}

/** Default singleton used by later transport tasks. */
export const matchService = new MatchService();

/**
 * Test/utility helper: current events for a match, in sequence order.
 * Kept here so the pipeline tests do not reach into the model directly.
 */
export async function listEventsForMatch(matchId: string): Promise<MatchEventDocument[]> {
  return MatchEventModel.find({ matchId }).sort({ seq: 1 }).lean<MatchEventDocument[]>().exec();
}
