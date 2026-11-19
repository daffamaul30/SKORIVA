/**
 * Match REST service (T-29).
 *
 * Lifecycle and operational actions share the same per-match serial queue.
 * Lifecycle requests use `txId` + `expectedVersion`, append an audit event, and
 * persist the lifecycle patch through the T-08 repository. No lifecycle path
 * mutates `matchStatus`/`resultDecision` directly.
 */

import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type {
  EventActor,
  EventType,
  MatchConfig,
  MatchState,
  MatchStatus,
  ResultCorrection,
  ResultDecision,
  ScoreboardView,
  Sport,
} from '@skoriva/shared';
import { env } from '../../config/env.js';
import { builtInSportRegistry } from '../../sports/builtins.js';
import { validateSportConfig } from '../../sports/shared/config-validation.js';
import { createSportReplayFolder } from '../../sports/shared/replay.js';
import { composeScoreboardView } from '../../sports/shared/display.js';
import { createReplayFn } from '../../core/snapshot.js';
import { matchQueue } from '../../core/match-queue.js';
import { buildSingleEvent } from '../../core/event-log.js';
import { assertConfigMutable, resolveLifecycleTransition } from '../../core/lifecycle.js';
import type { LifecycleAction } from '../../core/lifecycle.js';
import { correctResult, restoreResult } from '../../core/undo.js';
import { createMatchCredentials } from '../../access/tokens.js';
import { resolveOperatorAccess } from '../../access/guard.js';
import { verifyOperatorSession } from '../../access/operator-session.js';
import {
  appendEvents,
  claimMatchOwner,
  createMatch,
  deleteMatchById,
  findMatchEvents,
  loadMatchWithEvents,
  persistEventsAndState,
  replayMatchState,
  updateMatchMetadata,
} from '../../repositories/match.repo.js';
import type {
  LoadedMatchWithEvents,
  MatchLifecyclePatch,
  MatchMetadataPatch,
} from '../../repositories/match.repo.js';
import { findEventById } from '../../repositories/event.repo.js';
import { validateMatchEventLink } from '../event/validation.js';
import { publishMatchPatch, publishMatchStatus } from './match.publisher.js';
import { ApiError } from '../../middleware/error.js';
import type { MatchDocument, MatchEventDocument } from '../../models/index.js';
import type { CorrectionAudit } from '../../sports/shared/types.js';
import type {
  CorrectResultBody,
  CreateMatchRequest,
  EventListQuery,
  LifecycleBody,
  UpdateMatchRequest,
} from './match.schemas.js';

export type LifecycleActionName =
  'start' | 'finish' | 'cancel' | 'reopen' | 'save' | 'discard' | 'restore' | 'correct';

export interface MatchPayload {
  match: MatchDocument;
  display: ScoreboardView;
}

export type LifecycleDispatchResult =
  | {
      status: 'committed' | 'duplicate';
      version: number;
      txId: string;
      matchStatus: MatchStatus;
      resultDecision: ResultDecision;
    }
  | {
      status: 'version_conflict';
      version: number;
      txId: string;
      snapshot: MatchState;
    };

export type CorrectionDispatchResult =
  | {
      status: 'committed' | 'duplicate';
      version: number;
      txId: string;
      before: CorrectionAudit;
      after: CorrectionAudit;
    }
  | {
      status: 'version_conflict';
      version: number;
      txId: string;
      snapshot: MatchState;
    };

export type RestoreDispatchResult =
  | {
      status: 'committed' | 'duplicate';
      version: number;
      txId: string;
      matchStatus: MatchStatus;
      resultDecision: ResultDecision;
    }
  | {
      status: 'version_conflict';
      version: number;
      txId: string;
      snapshot: MatchState;
    };

const LIFECYCLE_EVENT: Record<
  Exclude<LifecycleActionName, 'restore' | 'correct'>,
  { action: LifecycleAction; event: EventType }
> = {
  start: { action: 'start', event: 'match.start' },
  finish: { action: 'finish', event: 'match.finish' },
  cancel: { action: 'cancel', event: 'match.cancel' },
  reopen: { action: 'reopen', event: 'match.reopen' },
  save: { action: 'save', event: 'result.save' },
  discard: { action: 'discard', event: 'result.discard' },
};

function createInitialState(sport: Sport, config: MatchConfig, now: Date): MatchState {
  const engine = builtInSportRegistry.get(sport);
  const timed = config.gameClock.mode === 'timed';
  const durationMs = timed ? config.periods.durationMs : 0;

  return {
    version: 0,
    period: {
      index: 0,
      label: config.periods.labels?.[0] ?? 'Period 1',
      status: 'active',
    },
    clock: {
      mode: config.gameClock.mode,
      remainingMs: durationMs,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: durationMs,
      lastDurableAt: now,
      recoveryPending: false,
    },
    sportState: engine.init(config),
    flags: { clockExpired: false, periodComplete: false },
  };
}

function toContextObject(context?: CreateMatchRequest['context']): MatchDocument['context'] {
  if (context?.eventId && !Types.ObjectId.isValid(context.eventId)) {
    throw new ApiError(400, 'INVALID_EVENT_ID', 'eventId is not a valid id.');
  }

  return {
    ...(context?.eventId ? { eventId: new Types.ObjectId(context.eventId) } : {}),
    ...(context?.stageLabel ? { stageLabel: context.stageLabel } : {}),
    ...(context?.matchNumber ? { matchNumber: context.matchNumber } : {}),
  };
}

function displayFor(match: MatchDocument, now: Date): ScoreboardView {
  const engine = builtInSportRegistry.get(match.sport);
  return composeScoreboardView(match, engine.deriveDisplay(match.state.sportState, now), now);
}

function toPayload(match: MatchDocument, now: Date): MatchPayload {
  return { match, display: displayFor(match, now) };
}

async function publishCurrent(matchId: string, kind: 'status' | 'patch'): Promise<void> {
  const loaded = await loadMatchWithEvents(matchId);
  if (!loaded) return;

  if (kind === 'status') {
    publishMatchStatus(loaded.match);
  } else {
    publishMatchPatch(loaded.match);
  }
}

async function replayIfNeeded(
  matchId: string,
  loaded: LoadedMatchWithEvents,
): Promise<LoadedMatchWithEvents> {
  if (!loaded.needsReplay) return loaded;

  const folder = createSportReplayFolder({
    registry: builtInSportRegistry,
    config: loaded.match.config,
    sport: loaded.match.sport,
  });
  const replayed = await replayMatchState(matchId, createReplayFn(folder));

  if (replayed.status === 'match_not_found') {
    throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
  }

  const reloaded = await loadMatchWithEvents(matchId);

  if (!reloaded) {
    throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
  }

  return reloaded;
}

async function appendContextEvent(
  matchId: string,
  fields: string[],
  actor: EventActor,
  now: Date,
): Promise<number> {
  const loaded = await loadMatchWithEvents(matchId);

  if (!loaded) {
    throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
  }

  const event = buildSingleEvent({
    seq: loaded.lastSeq + 1,
    txId: `context-${randomUUID()}`,
    type: 'context.update',
    payload: { fields },
    actor,
    now,
  });
  const state: MatchState = { ...loaded.match.state, version: event.seq };
  const persisted = await persistEventsAndState({ matchId, events: [event], state });

  if (persisted.status === 'match_not_found') {
    throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
  }

  if (persisted.status !== 'committed' && persisted.status !== 'duplicate_tx') {
    throw new ApiError(409, 'CONTEXT_UPDATE_FAILED', 'Could not persist the context update.');
  }

  return event.seq;
}

/** Create a match and append the `match.create` meta event (snapshot stays v0). */
export async function createMatchForRequest(
  input: CreateMatchRequest,
  accountId: string | undefined,
  now = new Date(),
): Promise<MatchPayload & { controlToken: string; viewCode: string }> {
  const engine = builtInSportRegistry.get(input.sport);
  const config = input.config ?? engine.defaults();
  const configCheck = validateSportConfig(input.sport, config);

  if (!configCheck.ok) {
    throw new ApiError(400, 'INVALID_CONFIG', configCheck.message);
  }

  const owner = accountId
    ? { type: 'account' as const, id: accountId }
    : { type: 'device' as const, id: randomUUID() };
  const context = toContextObject(input.context);

  if (context.eventId) {
    const event = await findEventById(context.eventId.toString());

    if (!event) {
      throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    }

    validateMatchEventLink({ sport: input.sport, owner }, event);
  }

  const credentials = createMatchCredentials(env.TOKEN_PEPPER, now);
  const created = await createMatch({
    sport: input.sport,
    teams: input.teams,
    config,
    context,
    matchStatus: 'ready',
    resultDecision: 'undecided',
    state: createInitialState(input.sport, config, now),
    access: credentials.access,
    owner,
  });

  const createEvent = buildSingleEvent({
    seq: 1,
    txId: `create-${randomUUID()}`,
    type: 'match.create',
    payload: { sport: input.sport, ownerType: owner.type },
    actor: accountId ? { type: 'account', id: accountId } : { type: 'system' },
    now,
  });

  try {
    await appendEvents(created._id.toString(), [createEvent]);
  } catch (error) {
    await deleteMatchById(created._id.toString()).catch(() => undefined);
    throw error;
  }

  return {
    ...toPayload(created, now),
    controlToken: credentials.controlToken,
    viewCode: credentials.viewCode,
  };
}

/** Claim a device-owned match for an account. */
export async function claimMatchForAccount(
  matchId: string,
  accountId: string,
  controlToken: string,
  now = new Date(),
): Promise<MatchPayload> {
  return matchQueue.run(matchId, async () => {
    const grant = await resolveOperatorAccess(matchId, controlToken, env.TOKEN_PEPPER);

    if (!grant) {
      throw new ApiError(
        403,
        'CONTROL_TOKEN_INVALID',
        'Control token is not valid for this match.',
      );
    }

    if (grant.match.owner.type === 'account') {
      if (grant.match.owner.id === accountId) {
        return toPayload(grant.match, now);
      }
      throw new ApiError(
        409,
        'MATCH_ALREADY_CLAIMED',
        'Match is already claimed by another account.',
      );
    }

    const updated = await claimMatchOwner(matchId, accountId);

    if (!updated) {
      throw new ApiError(409, 'MATCH_ALREADY_CLAIMED', 'Match is already claimed.');
    }

    await appendContextEvent(matchId, ['owner'], { type: 'account', id: accountId }, now);

    const reloaded = await loadMatchWithEvents(matchId);
    await publishCurrent(matchId, 'patch');
    return toPayload(reloaded?.match ?? updated, now);
  });
}

/** PATCH teams/config/context while READY (LC-02). */
export async function updateMatchForOperator(
  matchId: string,
  input: UpdateMatchRequest,
  operatorCredential: string,
  now = new Date(),
): Promise<MatchPayload> {
  return matchQueue.run(matchId, async () => {
    const { match, session } = await verifyOperatorSession(
      matchId,
      operatorCredential,
      env.TOKEN_PEPPER,
      now,
    );
    assertConfigMutable(match);

    if (input.config) {
      const configCheck = validateSportConfig(match.sport, input.config);
      if (!configCheck.ok) {
        throw new ApiError(400, 'INVALID_CONFIG', configCheck.message);
      }
    }

    const patch: MatchMetadataPatch = {};
    const fields: string[] = [];

    if (input.teams) {
      patch.teams = input.teams;
      fields.push('teams');
    }

    if (input.config) {
      patch.config = input.config;
      fields.push('config');
    }

    if (input.context !== undefined) {
      const nextContext = toContextObject(input.context);

      if (nextContext.eventId) {
        const event = await findEventById(nextContext.eventId.toString());

        if (!event) {
          throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
        }

        validateMatchEventLink({ sport: match.sport, owner: match.owner }, event);
      }

      patch.context = nextContext;
      fields.push('context');
    }

    const updated = await updateMatchMetadata(matchId, patch);

    if (!updated) {
      throw new ApiError(
        409,
        'CONFIG_LOCKED',
        'Teams and configuration can only be changed while the match is ready.',
      );
    }

    await appendContextEvent(matchId, fields, { type: 'operator', id: session.sessionId }, now);

    const reloaded = await loadMatchWithEvents(matchId);
    await publishCurrent(matchId, 'patch');
    return toPayload(reloaded?.match ?? updated, now);
  });
}

function lifecyclePatch(
  action: Exclude<LifecycleActionName, 'restore' | 'correct'>,
  transition: { matchStatus: MatchStatus; resultDecision: ResultDecision },
  now: Date,
): MatchLifecyclePatch {
  switch (action) {
    case 'start':
      return {
        matchStatus: transition.matchStatus,
        resultDecision: transition.resultDecision,
        startedAt: now,
      };
    case 'finish':
      return {
        matchStatus: transition.matchStatus,
        resultDecision: transition.resultDecision,
        finishedAt: now,
      };
    case 'cancel':
      return { matchStatus: transition.matchStatus };
    case 'reopen':
      return {
        matchStatus: transition.matchStatus,
        resultDecision: transition.resultDecision,
        clearFinishedAt: true,
      };
    case 'save':
    case 'discard':
      return { resultDecision: transition.resultDecision };
  }
}

/** Dispatch a lifecycle transition through the shared per-match queue. */
export async function dispatchLifecycle(
  matchId: string,
  action: Exclude<LifecycleActionName, 'restore' | 'correct'>,
  body: LifecycleBody,
  operatorCredential: string,
  now = new Date(),
): Promise<LifecycleDispatchResult> {
  return matchQueue.run(matchId, async () => {
    const { session } = await verifyOperatorSession(
      matchId,
      operatorCredential,
      env.TOKEN_PEPPER,
      now,
    );
    let loaded = await loadMatchWithEvents(matchId);

    if (!loaded) {
      throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
    }

    loaded = await replayIfNeeded(matchId, loaded);

    const duplicate = loaded.events.find((event) => event.txId === body.txId);
    if (duplicate) {
      return {
        status: 'duplicate' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        matchStatus: loaded.match.matchStatus,
        resultDecision: loaded.match.resultDecision,
      };
    }

    if (body.expectedVersion !== loaded.match.state.version) {
      return {
        status: 'version_conflict' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        snapshot: loaded.match.state,
      };
    }

    const config = LIFECYCLE_EVENT[action];
    const transition = resolveLifecycleTransition(loaded.match, config.action);
    const event = buildSingleEvent({
      seq: loaded.lastSeq + 1,
      txId: body.txId,
      type: config.event,
      payload: {
        from: {
          matchStatus: loaded.match.matchStatus,
          resultDecision: loaded.match.resultDecision,
        },
        to: transition,
      },
      actor: { type: 'operator', id: session.sessionId },
      now,
    });
    const state: MatchState = { ...loaded.match.state, version: event.seq };
    const persisted = await persistEventsAndState({
      matchId,
      events: [event],
      state,
      matchPatch: lifecyclePatch(action, transition, now),
    });

    if (persisted.status === 'match_not_found') {
      throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
    }

    if (persisted.status === 'duplicate_tx') {
      return {
        status: 'duplicate' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        matchStatus: loaded.match.matchStatus,
        resultDecision: loaded.match.resultDecision,
      };
    }

    if (persisted.status !== 'committed') {
      const refreshed = await loadMatchWithEvents(matchId);
      return {
        status: 'version_conflict' as const,
        version: refreshed?.match.state.version ?? loaded.match.state.version,
        txId: body.txId,
        snapshot: refreshed?.match.state ?? state,
      };
    }

    await publishCurrent(matchId, 'status');
    return {
      status: 'committed' as const,
      version: event.seq,
      txId: body.txId,
      matchStatus: transition.matchStatus,
      resultDecision: transition.resultDecision,
    };
  });
}

/** Correct a saved result with sport-specific validation and idempotency. */
export async function dispatchCorrectResult(
  matchId: string,
  body: CorrectResultBody,
  operatorCredential: string,
  now = new Date(),
): Promise<CorrectionDispatchResult> {
  return matchQueue.run(matchId, async () => {
    const { session } = await verifyOperatorSession(
      matchId,
      operatorCredential,
      env.TOKEN_PEPPER,
      now,
    );
    let loaded = await loadMatchWithEvents(matchId);

    if (!loaded) {
      throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
    }

    loaded = await replayIfNeeded(matchId, loaded);

    const duplicate = loaded.events.find((event) => event.txId === body.txId);
    if (duplicate) {
      if (duplicate.type !== 'result.correct') {
        throw new ApiError(409, 'TX_ID_CONFLICT', 'txId is already used by another event.');
      }

      const payload = duplicate.payload as {
        before?: CorrectionAudit;
        after?: CorrectionAudit;
      };

      if (!payload.before || !payload.after) {
        throw new ApiError(409, 'TX_ID_CONFLICT', 'Correction event is missing its audit payload.');
      }

      return {
        status: 'duplicate' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        before: payload.before,
        after: payload.after,
      };
    }

    if (body.expectedVersion !== loaded.match.state.version) {
      return {
        status: 'version_conflict' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        snapshot: loaded.match.state,
      };
    }

    const folder = createSportReplayFolder({
      registry: builtInSportRegistry,
      config: loaded.match.config,
      sport: loaded.match.sport,
    });
    const corrected = await correctResult({
      matchId,
      correction: body.correction as ResultCorrection,
      reason: body.reason,
      actor: { type: 'operator', id: session.sessionId },
      registry: builtInSportRegistry,
      folder,
      now,
      txId: body.txId,
    });

    await publishCurrent(matchId, 'patch');
    return {
      status: 'committed' as const,
      version: corrected.version,
      txId: body.txId,
      before: corrected.before,
      after: corrected.after,
    };
  });
}

/** Restore a discarded result to undecided with idempotency. */
export async function dispatchRestoreResult(
  matchId: string,
  body: LifecycleBody,
  operatorCredential: string,
  now = new Date(),
): Promise<RestoreDispatchResult> {
  return matchQueue.run(matchId, async () => {
    const { session } = await verifyOperatorSession(
      matchId,
      operatorCredential,
      env.TOKEN_PEPPER,
      now,
    );
    let loaded = await loadMatchWithEvents(matchId);

    if (!loaded) {
      throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
    }

    loaded = await replayIfNeeded(matchId, loaded);

    const duplicate = loaded.events.find((event) => event.txId === body.txId);
    if (duplicate) {
      if (duplicate.type !== 'result.restore') {
        throw new ApiError(409, 'TX_ID_CONFLICT', 'txId is already used by another event.');
      }

      return {
        status: 'duplicate' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        matchStatus: loaded.match.matchStatus,
        resultDecision: loaded.match.resultDecision,
      };
    }

    if (body.expectedVersion !== loaded.match.state.version) {
      return {
        status: 'version_conflict' as const,
        version: loaded.match.state.version,
        txId: body.txId,
        snapshot: loaded.match.state,
      };
    }

    const folder = createSportReplayFolder({
      registry: builtInSportRegistry,
      config: loaded.match.config,
      sport: loaded.match.sport,
    });
    const restored = await restoreResult({
      matchId,
      actor: { type: 'operator', id: session.sessionId },
      registry: builtInSportRegistry,
      folder,
      now,
      txId: body.txId,
    });

    await publishCurrent(matchId, 'status');
    return {
      status: 'committed' as const,
      version: restored.version,
      txId: body.txId,
      matchStatus: 'finished',
      resultDecision: 'undecided',
    };
  });
}

/** Paged operator event log, newest first. */
export async function listMatchEventsForOperator(
  matchId: string,
  query: EventListQuery,
): Promise<{ events: MatchEventDocument[]; nextBeforeSeq?: number }> {
  const events = await findMatchEvents(matchId);
  const filtered = query.beforeSeq
    ? events.filter((event) => event.seq < query.beforeSeq!)
    : events;
  const page = filtered.slice(-query.limit).reverse();
  const nextBeforeSeq = filtered.length > query.limit ? page[page.length - 1]?.seq : undefined;

  return { events: page, nextBeforeSeq };
}

export function matchDisplay(match: MatchDocument, now = new Date()): ScoreboardView {
  return displayFor(match, now);
}
