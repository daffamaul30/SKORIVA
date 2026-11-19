/**
 * Match wire types (T-31.4).
 *
 * Source of truth:
 * - `apps/api/src/modules/match/match.serializers.ts` (`SanitizedMatch`,
 *   `OperatorMatchResponse`, `ViewerMatchResponse`, `PublicResultResponse`,
 *   `LifecycleResponse`, `CorrectionResponse`, `EventListResponse`)
 * - `apps/api/src/modules/match/match.schemas.ts` (request bodies)
 *
 * `access` (hashes, operator session, handover code) is never serialised, so it
 * is not part of these types. Match runtime state is intentionally **not**
 * modelled here beyond `MatchStateSummary`: realtime snapshots belong to the
 * socket store (T-31.6), not to REST services or the query cache.
 */

import type {
  MatchAction,
  MatchConfig,
  MatchContext,
  MatchOwner,
  MatchState,
  MatchStatus,
  ResultCorrection,
  ResultDecision,
  ScoreboardView,
  Sport,
  TeamSide,
} from '@skoriva/shared';
import type { MatchTeams } from '@skoriva/shared';

/** `toSanitizedMatch` — no `access`, no `state`. */
export interface SanitizedMatch {
  id: string;
  sport: Sport;
  teams: MatchTeams;
  config: MatchConfig;
  context: {
    eventId?: string;
    stageLabel?: string;
    matchNumber?: number;
  };
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  owner: MatchOwner;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/matches/:id` with `X-Operator-Session`.
 * `state` is the persisted snapshot; live values come from the socket.
 */
export interface OperatorMatchResponse {
  match: SanitizedMatch;
  state: MatchState;
  display: ScoreboardView;
}

/**
 * `GET /api/matches/:id` with a viewer code.
 * `display` is omitted while the result is not publicly visible.
 */
export interface ViewerMatchResponse {
  display?: ScoreboardView;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
}

/** `GET /api/matches/:id/result` — display only when `saved`. */
export interface PublicResultResponse {
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
  display?: ScoreboardView;
}

/** `POST /api/matches` — plaintext credentials are returned exactly once. */
export interface CreateMatchResponse extends OperatorMatchResponse {
  controlToken: string;
  viewCode: string;
}

/** `createMatchSchema` body; owner/access/state are derived by the server. */
export interface CreateMatchInput {
  sport: Sport;
  teams: MatchTeams;
  config?: MatchConfig;
  context?: MatchContext;
}

/** `PATCH /api/matches/:id` body; only allowed while READY (LC-02). */
export interface UpdateMatchInput {
  teams?: MatchTeams;
  config?: MatchConfig;
  context?: MatchContext;
}

/** `GET /api/matches/:id/events` query. */
export interface MatchEventsQuery {
  limit?: number;
  beforeSeq?: number;
}

export interface SerializedMatchEvent {
  seq: number;
  txId: string;
  type: string;
  payload: unknown;
  actor: { type: 'operator' | 'system' | 'account'; id?: string };
  serverTs: string;
  appliedAt: string;
}

/** `toEventListResponse` — opaque cursor for the next page. */
export interface MatchEventListResponse {
  events: SerializedMatchEvent[];
  nextBeforeSeq?: number;
}

/** `lifecycleBodySchema` / `correctResultSchema` in the request direction. */
export interface LifecycleRequest {
  txId: string;
  expectedVersion: number;
  sessionCredential: string;
}

export interface CorrectResultRequest extends LifecycleRequest {
  reason: string;
  correction: ResultCorrection;
}

/** `toLifecycleResponse`. */
export interface LifecycleResponse {
  version: number;
  txId: string;
  matchStatus: MatchStatus;
  resultDecision: ResultDecision;
}

/** `CorrectionAudit` as serialised by the API. */
export interface CorrectionAuditSnapshot {
  [key: string]: unknown;
}

/** `toCorrectionResponse`. */
export interface CorrectionResponse {
  version: number;
  txId: string;
  before: CorrectionAuditSnapshot;
  after: CorrectionAuditSnapshot;
}

/** Re-exported so callers do not reach into `@skoriva/shared` ad hoc. */
export type { MatchAction, TeamSide };
