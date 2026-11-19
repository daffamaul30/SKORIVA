/**
 * Data-fetching defaults (T-31.3).
 *
 * TanStack Query owns **server state only** (auth session, events, match
 * metadata, match event log). Realtime match state stays out of the cache.
 *
 * Staleness is deliberately short because the backend is the single source of
 * truth and operators need fresh reads after lifecycle transitions.
 */

import { isApiClientError } from '../api/api-error';

export const QUERY_STALE_TIME_MS = 15_000;
export const QUERY_RETRY_LIMIT = 2;
export const MUTATION_RETRY_LIMIT = 0;

/** HTTP statuses that can never succeed by repeating the same request. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

/**
 * Backend/client codes that encode a deterministic rejection. Re-sending the
 * same request cannot help, so retrying only delays the error to the user.
 */
const NON_RETRYABLE_CODES = new Set([
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'EMAIL_ALREADY_REGISTERED',
  'FORBIDDEN',
  'UNTRUSTED_ORIGIN',
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'MATCH_NOT_FOUND',
  'NOT_FOUND',
  'INVALID_MATCH_ID',
  'INVALID_EVENT_ID',
  'VERSION_CONFLICT',
  'STATE_CONFLICT',
  'LIFECYCLE_VIA_REST',
  'OPERATOR_SESSION_REQUIRED',
  'OPERATOR_SESSION_INVALID',
  'OPERATOR_SESSION_REVOKED',
  'OPERATOR_SESSION_EXPIRED',
  'OPERATOR_SESSION_STALE',
  'OPERATOR_SESSION_CONFLICT',
  'HANDOVER_CODE_INVALID',
  'HANDOVER_CODE_EXPIRED',
  'JOIN_REQUIRED',
  'VIEW_CODE_REQUIRED',
  'VIEW_CODE_INVALID',
  // The server answered; repeating an unreadable body will not fix it.
  'INVALID_RESPONSE_BODY',
  'INVALID_ERROR_BODY',
  'REQUEST_ABORTED',
]);

/**
 * Decide whether a failed query should be retried.
 *
 * - `ApiClientError` with a deterministic status/code → never.
 * - Network/unknown server failures → retried, capped by the caller's
 *   `retry` count (TanStack passes the failure count as the second argument).
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRY_LIMIT) {
    return false;
  }

  if (isApiClientError(error)) {
    if (NON_RETRYABLE_STATUSES.has(error.status)) {
      return false;
    }
    if (NON_RETRYABLE_CODES.has(error.code)) {
      return false;
    }
  }

  return true;
}

/** Exponential backoff capped at 5s, so a flaky network stabilises quickly. */
export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1_000 * 2 ** attemptIndex, 5_000);
}

/**
 * Mutations are never retried automatically: lifecycle calls carry a `txId`
 * and an operator session proof, and a blind retry could hide a real rejection.
 * Idempotency is handled explicitly by the caller via `txId`.
 */
export function shouldRetryMutation(): boolean {
  return false;
}
