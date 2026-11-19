/**
 * Response serializers for the Match REST module (T-29).
 *
 * Every serializer strips `MatchDocument.access` (hashes, operator session,
 * handover code) and never emits plaintext credentials. The operator payload may
 * include `state`; the viewer and public-result payloads never do.
 */

import type { ScoreboardView } from '@skoriva/shared';
import type { MatchDocument, MatchEventDocument } from '../../models/index.js';
import type { CorrectionAudit } from '../../sports/shared/types.js';

export interface SanitizedMatch {
  id: string;
  sport: MatchDocument['sport'];
  teams: MatchDocument['teams'];
  config: MatchDocument['config'];
  context: {
    eventId?: string;
    stageLabel?: string;
    matchNumber?: number;
  };
  matchStatus: MatchDocument['matchStatus'];
  resultDecision: MatchDocument['resultDecision'];
  owner: MatchDocument['owner'];
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatorMatchResponse {
  match: SanitizedMatch;
  state: MatchDocument['state'];
  display: ScoreboardView;
}

export interface ViewerMatchResponse {
  display?: ScoreboardView;
  matchStatus: MatchDocument['matchStatus'];
  resultDecision: MatchDocument['resultDecision'];
}

export interface PublicResultResponse {
  matchStatus: MatchDocument['matchStatus'];
  resultDecision: MatchDocument['resultDecision'];
  display?: ScoreboardView;
}

export interface LifecycleResponse {
  version: number;
  txId: string;
  matchStatus: MatchDocument['matchStatus'];
  resultDecision: MatchDocument['resultDecision'];
}

export interface CorrectionResponse {
  version: number;
  txId: string;
  before: CorrectionAudit;
  after: CorrectionAudit;
}

export interface SerializedEvent {
  seq: number;
  txId: string;
  type: MatchEventDocument['type'];
  payload: MatchEventDocument['payload'];
  actor: MatchEventDocument['actor'];
  serverTs: Date;
  appliedAt: Date;
}

export interface EventListResponse {
  events: SerializedEvent[];
  nextBeforeSeq?: number;
}

export function toSanitizedMatch(match: MatchDocument): SanitizedMatch {
  return {
    id: match._id.toString(),
    sport: match.sport,
    teams: match.teams,
    config: match.config,
    context: {
      ...(match.context.eventId ? { eventId: match.context.eventId.toString() } : {}),
      ...(match.context.stageLabel ? { stageLabel: match.context.stageLabel } : {}),
      ...(match.context.matchNumber ? { matchNumber: match.context.matchNumber } : {}),
    },
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
    owner: match.owner,
    ...(match.startedAt ? { startedAt: match.startedAt } : {}),
    ...(match.finishedAt ? { finishedAt: match.finishedAt } : {}),
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
  };
}

export function toOperatorMatchResponse(
  match: MatchDocument,
  display: ScoreboardView,
): OperatorMatchResponse {
  return {
    match: toSanitizedMatch(match),
    state: match.state,
    display,
  };
}

export function toViewerMatchResponse(
  match: MatchDocument,
  display: ScoreboardView,
): ViewerMatchResponse {
  const showDisplay =
    match.matchStatus === 'ready' ||
    match.matchStatus === 'live' ||
    (match.matchStatus === 'finished' && match.resultDecision === 'saved');

  return {
    ...(showDisplay ? { display } : {}),
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
  };
}

export function toPublicResultResponse(
  match: MatchDocument,
  display: ScoreboardView,
): PublicResultResponse {
  if (match.resultDecision === 'saved') {
    return {
      matchStatus: match.matchStatus,
      resultDecision: match.resultDecision,
      display,
    };
  }

  return {
    matchStatus: match.matchStatus,
    resultDecision: match.resultDecision,
  };
}

export function toCreateMatchResponse(
  match: MatchDocument,
  display: ScoreboardView,
  controlToken: string,
  viewCode: string,
): OperatorMatchResponse & { controlToken: string; viewCode: string } {
  return {
    ...toOperatorMatchResponse(match, display),
    controlToken,
    viewCode,
  };
}

export function toLifecycleResponse(input: {
  version: number;
  txId: string;
  matchStatus: MatchDocument['matchStatus'];
  resultDecision: MatchDocument['resultDecision'];
}): LifecycleResponse {
  return input;
}

export function toCorrectionResponse(input: {
  version: number;
  txId: string;
  before: CorrectionAudit;
  after: CorrectionAudit;
}): CorrectionResponse {
  return input;
}

export function toSerializedEvent(event: MatchEventDocument): SerializedEvent {
  return {
    seq: event.seq,
    txId: event.txId,
    type: event.type,
    payload: event.payload,
    actor: event.actor,
    serverTs: event.serverTs,
    appliedAt: event.appliedAt,
  };
}

export function toEventListResponse(
  events: MatchEventDocument[],
  nextBeforeSeq?: number,
): EventListResponse {
  return {
    events: events.map(toSerializedEvent),
    ...(nextBeforeSeq !== undefined ? { nextBeforeSeq } : {}),
  };
}
