/**
 * Match lifecycle REST service (T-31.4).
 *
 * Lifecycle transitions travel over REST (B-06); operational actions
 * (score/clock/period/sport/undo) stay on Socket.IO and are **not** here.
 *
 * Every call sends `{ txId, expectedVersion }` in the body plus the operator
 * session proof as the `X-Operator-Session` header. The credential never goes
 * into the body, the URL, or a cached payload.
 */

import { endpoints } from '@/lib/api/endpoints';
import { apiRequest } from '@/lib/api/http-client';
import type { CorrectResultRequest, CorrectionResponse, LifecycleResponse } from './matches.types';

export interface LifecycleInput {
  matchId: string;
  txId: string;
  expectedVersion: number;
  sessionCredential: string;
}

function postLifecycle(path: string, input: LifecycleInput): Promise<LifecycleResponse> {
  return apiRequest<LifecycleResponse>(path, {
    method: 'POST',
    body: { txId: input.txId, expectedVersion: input.expectedVersion },
    sessionCredential: input.sessionCredential,
  });
}

/** `POST /:id/start` — READY → LIVE. */
export function startMatch(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.start(input.matchId), input);
}

/** `POST /:id/finish` — LIVE → FINISHED (`resultDecision` stays undecided). */
export function finishMatch(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.finish(input.matchId), input);
}

/** `POST /:id/cancel` — READY/LIVE → CANCELLED (terminal, not a discard). */
export function cancelMatch(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.cancel(input.matchId), input);
}

/** `POST /:id/reopen` — FINISHED(undecided) → LIVE. */
export function reopenMatch(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.reopen(input.matchId), input);
}

/** `POST /:id/save-result` — FINISHED(undecided) → saved. */
export function saveResult(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.saveResult(input.matchId), input);
}

/** `POST /:id/discard-result` — FINISHED(undecided) → discarded. */
export function discardResult(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.discardResult(input.matchId), input);
}

/** `POST /:id/restore-result` — discarded → undecided. */
export function restoreResult(input: LifecycleInput): Promise<LifecycleResponse> {
  return postLifecycle(endpoints.matches.restoreResult(input.matchId), input);
}

/**
 * `POST /:id/correct-result` — sport-specific correction while `saved`.
 * `reason` is mandatory (B-10); the payload is validated by the sport engine.
 */
export function correctResult(input: CorrectResultRequest & { matchId: string }): Promise<CorrectionResponse> {
  return apiRequest<CorrectionResponse>(endpoints.matches.correctResult(input.matchId), {
    method: 'POST',
    body: {
      txId: input.txId,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      correction: input.correction,
    },
    sessionCredential: input.sessionCredential,
  });
}
