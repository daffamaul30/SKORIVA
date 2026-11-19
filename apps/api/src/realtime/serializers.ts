/**
 * Role-scoped realtime serializers (T-25).
 *
 * Operator payloads may contain internal state. Viewer payloads contain only the
 * minimal display and public status, and hide the display when the result is not
 * publicly visible (finished-undecided/discarded/cancelled).
 */

import type { MatchStatus, ResultDecision, ScoreboardView } from '@skoriva/shared';
import type { MatchDocument } from '../models/index.js';
import { builtInSportRegistry } from '../sports/builtins.js';
import { composeScoreboardView } from '../sports/shared/display.js';

export interface OperatorSnapshotPayload {
  matchId: string;
  version: number;
  state: MatchDocument['state'];
  display: ScoreboardView;
  serverTs: string;
}

export interface ViewerSnapshotPayload {
  matchId: string;
  version: number;
  display?: ScoreboardView;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  serverTs: string;
}

export interface OperatorPatchPayload extends OperatorSnapshotPayload {
  event?: {
    seq: number;
    type: string;
    payload: unknown;
  };
}

export type ViewerPatchPayload = ViewerSnapshotPayload;

export interface MatchStatusPayload {
  matchId: string;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
}

export interface OperatorStatePayload {
  active: boolean;
  actorRef?: string;
  /** ISO timestamp while the active operator is inside the grace window. */
  graceUntil?: string;
}

export interface OperatorSessionPayload {
  matchId: string;
  sessionId: string;
  credential?: string;
  expiresAt: string;
}

export interface MatchErrorPayload {
  code: string;
  message: string;
  currentVersion?: number;
  snapshot?: OperatorSnapshotPayload | ViewerSnapshotPayload;
}

function displayFor(match: MatchDocument, now: Date): ScoreboardView {
  const engine = builtInSportRegistry.get(match.sport);
  return composeScoreboardView(match, engine.deriveDisplay(match.state.sportState, now), now);
}

function viewerDisplayVisible(match: MatchDocument): boolean {
  return (
    match.matchStatus === 'ready' ||
    match.matchStatus === 'live' ||
    (match.matchStatus === 'finished' && match.resultDecision === 'saved')
  );
}

export function toOperatorSnapshot(
  match: MatchDocument,
  now = new Date(),
): OperatorSnapshotPayload {
  return {
    matchId: match._id.toString(),
    version: match.state.version,
    state: match.state,
    display: displayFor(match, now),
    serverTs: now.toISOString(),
  };
}

export function toViewerSnapshot(match: MatchDocument, now = new Date()): ViewerSnapshotPayload {
  return {
    matchId: match._id.toString(),
    version: match.state.version,
    ...(viewerDisplayVisible(match) ? { display: displayFor(match, now) } : {}),
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
    serverTs: now.toISOString(),
  };
}

export function toOperatorPatch(
  match: MatchDocument,
  now = new Date(),
  event?: OperatorPatchPayload['event'],
): OperatorPatchPayload {
  return {
    ...toOperatorSnapshot(match, now),
    ...(event ? { event } : {}),
  };
}

export function toViewerPatch(match: MatchDocument, now = new Date()): ViewerPatchPayload {
  return toViewerSnapshot(match, now);
}

export function toMatchStatusPayload(match: MatchDocument): MatchStatusPayload {
  return {
    matchId: match._id.toString(),
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
  };
}

export function toOperatorStatePayload(input: {
  active: boolean;
  actorRef?: string;
  graceUntil?: Date;
}): OperatorStatePayload {
  return {
    active: input.active,
    ...(input.actorRef ? { actorRef: input.actorRef } : {}),
    ...(input.graceUntil ? { graceUntil: input.graceUntil.toISOString() } : {}),
  };
}

export function toOperatorSessionPayload(input: {
  matchId: string;
  sessionId: string;
  credential?: string;
  expiresAt: Date;
}): OperatorSessionPayload {
  return {
    matchId: input.matchId,
    sessionId: input.sessionId,
    ...(input.credential ? { credential: input.credential } : {}),
    expiresAt: input.expiresAt.toISOString(),
  };
}

export function toMatchErrorPayload(input: {
  code: string;
  message: string;
  currentVersion?: number;
  snapshot?: OperatorSnapshotPayload | ViewerSnapshotPayload;
}): MatchErrorPayload {
  return {
    code: input.code,
    message: input.message,
    ...(input.currentVersion !== undefined ? { currentVersion: input.currentVersion } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  };
}
