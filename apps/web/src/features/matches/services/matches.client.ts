/**
 * Match REST service (T-31.4).
 *
 * Access split mirrors the backend exactly (`requireAnyMatchAccess`):
 * - `X-Operator-Session` present → operator payload (`match` + `state` + `display`);
 * - otherwise the viewer code is required → minimal viewer payload.
 *
 * Credential handling: `createMatch` adopts the returned `controlToken` into the
 * operator credential store (memory only). Every other call takes the session
 * credential as an argument, read by the caller at request time. The viewer code
 * is passed only where the backend reads it (`X-View-Code`) and never becomes
 * part of a query key or cache entry.
 */

import { endpoints } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/http-client';
import { useOperatorCredentials } from '@/lib/store/operator-credentials.store';
import type {
  CreateMatchInput,
  CreateMatchResponse,
  MatchEventListResponse,
  MatchEventsQuery,
  OperatorMatchResponse,
  PublicResultResponse,
  UpdateMatchInput,
  ViewerMatchResponse,
} from './matches.types';

/**
 * `POST /api/matches` → 201.
 *
 * `controlToken` and `viewCode` are plaintext and returned **once**.
 *
 * The `controlToken` is adopted into the operator credential store immediately
 * (in memory only) so the very next `match:join` can claim the operator slot
 * without any UI having to remember it. It is never logged, cached in a query,
 * persisted, or placed in a URL.
 *
 * `viewCode` is deliberately **not** stored: it is returned to the caller for a
 * single display step so the viewer link can be distributed. Keeping it out of
 * the credential store prevents mixing viewer access with operator ownership.
 */
export async function createMatch(input: CreateMatchInput): Promise<CreateMatchResponse> {
  const response = await apiClient.post<CreateMatchResponse>(endpoints.matches.create(), input);

  useOperatorCredentials.getState().setInitialControlToken({
    matchId: response.match.id,
    controlToken: response.controlToken,
  });

  return response;
}

/** `GET /api/matches/:id` as operator (requires the session credential). */
export async function getMatchAsOperator(
  matchId: string,
  sessionCredential: string,
): Promise<OperatorMatchResponse> {
  return apiClient.get<OperatorMatchResponse>(endpoints.matches.detail(matchId), {
    sessionCredential,
  });
}

/**
 * `GET /api/matches/:id` as viewer.
 *
 * The backend accepts the code from `?code=` or the `x-view-code` header. The
 * header keeps it out of URLs and logs (R-03), so this service only uses it.
 */
export async function getMatchAsViewer(
  matchId: string,
  viewCode: string,
): Promise<ViewerMatchResponse> {
  return apiClient.get<ViewerMatchResponse>(endpoints.matches.detail(matchId), {
    viewerCode: viewCode,
  });
}

/** `PATCH /api/matches/:id` — only while READY (LC-02). */
export async function updateMatch(
  matchId: string,
  input: UpdateMatchInput,
  sessionCredential: string,
): Promise<OperatorMatchResponse> {
  return apiClient.patch<OperatorMatchResponse>(endpoints.matches.update(matchId), input, {
    sessionCredential,
  });
}

/** `GET /api/matches/:id/events` — newest first, cursor via `nextBeforeSeq`. */
export async function listMatchEventLog(
  matchId: string,
  query: MatchEventsQuery,
  sessionCredential: string,
): Promise<MatchEventListResponse> {
  return apiClient.get<MatchEventListResponse>(endpoints.matches.events(matchId), {
    query: { limit: query.limit, beforeSeq: query.beforeSeq },
    sessionCredential,
  });
}

/** `GET /api/matches/:id/result` — viewer access; display only when `saved`. */
export async function getPublicResult(
  matchId: string,
  viewCode: string,
): Promise<PublicResultResponse> {
  return apiClient.get<PublicResultResponse>(endpoints.matches.result(matchId), {
    viewerCode: viewCode,
  });
}
