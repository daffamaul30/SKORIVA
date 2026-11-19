/**
 * Undo, correction, and restore via the append-only event log (T-18).
 *
 * Undo recomputes state from the log. It never uses inverse reducers and never
 * deletes events. One action is identified by its transaction id: the first
 * event carries `actionTxId`, later events carry `${actionTxId}:${seq}`.
 *
 * Correction is deterministic: `engine.correct()` produces the new sport state
 * and the stored `after` audit; replay re-runs the same correction and fails
 * loudly if the result differs.
 */

import { randomUUID } from 'node:crypto';
import type { EventActor, MatchState, ResultCorrection } from '@skoriva/shared';
import type { MatchDocument, MatchEventDocument } from '../models/index.js';
import { loadMatchWithEvents, persistEventsAndState } from '../repositories/match.repo.js';
import type { NewMatchEvent } from '../repositories/match.repo.js';
import { foldEvents } from './snapshot.js';
import type { EventFolder, ReplayableEvent } from './snapshot.js';
import { isOperationalEventType } from './event-log.js';
import type { SportRegistry } from '../sports/registry.js';
import type { CorrectionAudit, SportEngineRuntime } from '../sports/shared/types.js';

export type UndoErrorCode =
  | 'MATCH_NOT_FOUND'
  | 'UNDO_NOT_ALLOWED'
  | 'UNDO_REQUIRES_CORRECTION'
  | 'UNDO_TARGET_NOT_FOUND'
  | 'UNDO_TARGET_INVALID'
  | 'UNDO_NOT_LAST'
  | 'UNDO_NEGATIVE_SCORE'
  | 'CORRECTION_NOT_ALLOWED'
  | 'CORRECTION_INVALID'
  | 'RESTORE_NOT_ALLOWED';

export class UndoError extends Error {
  constructor(
    readonly code: UndoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

export interface UndoDeps {
  registry: SportRegistry;
  folder: EventFolder;
  now?: Date;
}

export interface UndoActionInput extends UndoDeps {
  matchId: string;
  targetSeq: number;
  actor: EventActor;
}

export interface CorrectResultInput extends UndoDeps {
  matchId: string;
  correction: ResultCorrection;
  reason: string;
  actor: EventActor;
  /** Optional REST idempotency key; generated when omitted. */
  txId?: string;
}

export interface RestoreResultInput extends UndoDeps {
  matchId: string;
  actor: EventActor;
  /** Optional REST idempotency key; generated when omitted. */
  txId?: string;
}

export interface UndoResult {
  status: 'committed';
  targetSeq: number;
  actionTxId: string;
  version: number;
  events: MatchEventDocument[];
}

/** Minimal event shape needed to resolve undo targets. */
export type UndoEventLike = ReplayableEvent & { txId: string };

/** Reconstruct the initial state (v0) for a match from its config. */
export function initialMatchState(match: MatchDocument, engine: SportEngineRuntime): MatchState {
  const durationMs = match.config.gameClock.mode === 'timed' ? match.config.periods.durationMs : 0;

  return {
    version: 0,
    period: {
      index: 0,
      label: match.config.periods.labels?.[0] ?? 'Period 1',
      status: 'active',
    },
    clock: {
      mode: match.config.gameClock.mode,
      remainingMs: durationMs,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: durationMs,
      lastDurableAt: match.createdAt ?? new Date(0),
      recoveryPending: false,
    },
    sportState: engine.init(match.config),
    flags: { clockExpired: false, periodComplete: false },
  };
}

/**
 * Resolve the action transaction id for an event. The first event of an action
 * has txId = actionTxId; later events have `${actionTxId}:${seq}`. Candidate
 * prefixes are only accepted when the first event actually exists, which keeps
 * action ids that contain ':' intact.
 */
export function resolveActionTxId(
  event: Pick<UndoEventLike, 'txId' | 'seq'>,
  events: readonly Pick<UndoEventLike, 'txId' | 'seq'>[],
): string {
  const suffix = `:${event.seq}`;

  if (event.txId.endsWith(suffix)) {
    const candidate = event.txId.slice(0, -suffix.length);
    if (events.some((item) => item.txId === candidate)) {
      return candidate;
    }
  }

  return event.txId;
}

/** All events belonging to one action. */
export function collectActionEvents(
  events: readonly UndoEventLike[],
  actionTxId: string,
): UndoEventLike[] {
  return events.filter(
    (event) => event.txId === actionTxId || event.txId.startsWith(`${actionTxId}:`),
  );
}

/**
 * Sequence numbers to skip when folding: every undo event itself and every
 * event of the action it targets.
 */
export function collectUndoTargets(events: readonly UndoEventLike[]): Set<number> {
  const skip = new Set<number>();
  const undoEvents = events.filter((event) => event.type === 'match.undo');

  for (const undo of undoEvents) {
    skip.add(undo.seq);

    const targetSeq = Number((undo.payload as { targetSeq?: unknown }).targetSeq);
    const target = events.find((event) => event.seq === targetSeq);

    if (!target) continue;

    const actionTxId = resolveActionTxId(target, events);
    for (const event of collectActionEvents(events, actionTxId)) {
      skip.add(event.seq);
    }
  }

  return skip;
}

/** Fold the log while omitting undone actions and undo markers. */
export function foldWithUndo(
  baseState: MatchState,
  events: readonly UndoEventLike[],
  folder: EventFolder,
): MatchState {
  const skip = collectUndoTargets(events);
  return foldEvents(
    baseState,
    events.filter((event) => !skip.has(event.seq)),
    folder,
  );
}

function recomputeFromLog(
  match: MatchDocument,
  events: readonly MatchEventDocument[],
  engine: SportEngineRuntime,
  folder: EventFolder,
): MatchState {
  const initial = initialMatchState(match, engine);
  return foldEvents(initial, events, folder);
}

function assertUndoAllowed(match: MatchDocument): void {
  if (match.matchStatus === 'finished' && match.resultDecision === 'saved') {
    throw new UndoError(
      'UNDO_REQUIRES_CORRECTION',
      'A saved result cannot be undone; use result correction instead.',
    );
  }

  const allowed =
    match.matchStatus === 'live' ||
    (match.matchStatus === 'finished' && match.resultDecision === 'undecided');

  if (!allowed) {
    throw new UndoError(
      'UNDO_NOT_ALLOWED',
      'Undo is only available on live or finished-undecided matches.',
    );
  }
}

function assertNonNegative(state: MatchState, engine: SportEngineRuntime, now: Date): void {
  const display = engine.deriveDisplay(state.sportState, now);
  const scores = [
    display.score.home,
    display.score.away,
    ...(display.sets ?? []).flatMap((set) => [set.home, set.away]),
  ];

  if (scores.some((value) => value < 0)) {
    throw new UndoError('UNDO_NEGATIVE_SCORE', 'Undo would produce a negative score.');
  }
}

function isUndoableEvent(event: MatchEventDocument): boolean {
  return isOperationalEventType(event.type) && event.type !== 'match.undo';
}

function lastOperationalEvent(
  events: readonly MatchEventDocument[],
): MatchEventDocument | undefined {
  return [...events].reverse().find(isUndoableEvent);
}

/** Undo one complete action by action identity. */
export async function undoAction(input: UndoActionInput): Promise<UndoResult> {
  const now = input.now ?? new Date();
  const loaded = await loadMatchWithEvents(input.matchId);

  if (!loaded) {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  assertUndoAllowed(loaded.match);

  const target = loaded.events.find((event) => event.seq === input.targetSeq);

  if (!target) {
    throw new UndoError('UNDO_TARGET_NOT_FOUND', `Event seq ${input.targetSeq} was not found.`);
  }

  if (!isUndoableEvent(target)) {
    throw new UndoError(
      'UNDO_TARGET_INVALID',
      'Only operational actions can be undone; lifecycle, access, correction, and undo events cannot.',
    );
  }

  const actionTxId = resolveActionTxId(target, loaded.events);
  const lastAction = lastOperationalEvent(loaded.events);

  if (!lastAction || resolveActionTxId(lastAction, loaded.events) !== actionTxId) {
    throw new UndoError(
      'UNDO_NOT_LAST',
      'Only the most recent action can be undone. Undo later actions first.',
    );
  }

  const undoEvent: NewMatchEvent = {
    seq: loaded.maxSeq + 1,
    txId: `undo-${randomUUID()}`,
    type: 'match.undo',
    payload: { targetSeq: input.targetSeq, actionTxId },
    actor: input.actor,
    serverTs: now,
    appliedAt: now,
  };

  const engine = input.registry.get(loaded.match.sport);
  const initial = initialMatchState(loaded.match, engine);
  const folded = foldWithUndo(initial, [...loaded.events, undoEvent], input.folder);
  const nextState: MatchState = { ...folded, version: undoEvent.seq };

  assertNonNegative(nextState, engine, now);

  const persisted = await persistEventsAndState({
    matchId: input.matchId,
    events: [undoEvent],
    state: nextState,
  });

  if (persisted.status === 'match_not_found') {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  if (persisted.status !== 'committed' && persisted.status !== 'duplicate_tx') {
    throw new UndoError('UNDO_NOT_ALLOWED', `Undo could not be committed: ${persisted.status}.`);
  }

  return {
    status: 'committed',
    targetSeq: input.targetSeq,
    actionTxId,
    version: undoEvent.seq,
    events: persisted.events,
  };
}

function auditFromState(state: MatchState, engine: SportEngineRuntime, now: Date): CorrectionAudit {
  const display = engine.deriveDisplay(state.sportState, now);
  return {
    score: display.score,
    ...(display.sets ? { sets: display.sets } : {}),
  };
}

/** Correct a saved result without changing lifecycle status (LC-05). */
export async function correctResult(
  input: CorrectResultInput,
): Promise<{ version: number; before: CorrectionAudit; after: CorrectionAudit }> {
  const now = input.now ?? new Date();

  if (input.reason.trim().length === 0) {
    throw new UndoError('CORRECTION_INVALID', 'A correction reason is required.');
  }

  const loaded = await loadMatchWithEvents(input.matchId);

  if (!loaded) {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  if (loaded.match.matchStatus !== 'finished' || loaded.match.resultDecision !== 'saved') {
    throw new UndoError(
      'CORRECTION_NOT_ALLOWED',
      'Only a finished, saved result can be corrected.',
    );
  }

  const engine = input.registry.get(loaded.match.sport);
  const current = recomputeFromLog(loaded.match, loaded.events, engine, input.folder);
  const corrected = engine.correct(current, input.correction, loaded.match.config);

  if (!corrected.ok) {
    throw new UndoError('CORRECTION_INVALID', corrected.message);
  }

  const before = auditFromState(current, engine, now);
  const after = corrected.after;
  const event: NewMatchEvent = {
    seq: loaded.maxSeq + 1,
    txId: input.txId ?? `correct-${randomUUID()}`,
    type: 'result.correct',
    payload: {
      before,
      after,
      reason: input.reason,
      correction: input.correction,
    },
    actor: input.actor,
    serverTs: now,
    appliedAt: now,
  };

  // Replay through the same folder to guarantee the stored `after` is exactly
  // what a later replay will produce.
  const initial = initialMatchState(loaded.match, engine);
  const nextState = foldEvents(initial, [...loaded.events, event], input.folder);

  const persisted = await persistEventsAndState({
    matchId: input.matchId,
    events: [event],
    state: nextState,
  });

  if (persisted.status === 'match_not_found') {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  if (persisted.status !== 'committed' && persisted.status !== 'duplicate_tx') {
    throw new UndoError(
      'CORRECTION_INVALID',
      `Correction could not be committed: ${persisted.status}.`,
    );
  }

  return { version: event.seq, before, after };
}

/** Restore a discarded result to undecided; match status stays finished. */
export async function restoreResult(input: RestoreResultInput): Promise<{ version: number }> {
  const now = input.now ?? new Date();
  const loaded = await loadMatchWithEvents(input.matchId);

  if (!loaded) {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  if (loaded.match.matchStatus !== 'finished' || loaded.match.resultDecision !== 'discarded') {
    throw new UndoError(
      'RESTORE_NOT_ALLOWED',
      'Only a finished, discarded result can be restored.',
    );
  }

  const engine = input.registry.get(loaded.match.sport);
  const current = recomputeFromLog(loaded.match, loaded.events, engine, input.folder);
  const event: NewMatchEvent = {
    seq: loaded.maxSeq + 1,
    txId: input.txId ?? `restore-${randomUUID()}`,
    type: 'result.restore',
    payload: {},
    actor: input.actor,
    serverTs: now,
    appliedAt: now,
  };

  const nextState: MatchState = { ...current, version: event.seq };

  const persisted = await persistEventsAndState({
    matchId: input.matchId,
    events: [event],
    state: nextState,
    matchPatch: { resultDecision: 'undecided' },
  });

  if (persisted.status === 'match_not_found') {
    throw new UndoError('MATCH_NOT_FOUND', 'Match not found.');
  }

  if (persisted.status !== 'committed' && persisted.status !== 'duplicate_tx') {
    throw new UndoError(
      'RESTORE_NOT_ALLOWED',
      `Restore could not be committed: ${persisted.status}.`,
    );
  }

  return { version: event.seq };
}
