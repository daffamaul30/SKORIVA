/**
 * Domain error mapping for REST handlers (T-29).
 *
 * Converts typed domain errors into stable `ApiError` responses. Unknown errors
 * continue to the generic 500 handler. No error message includes credentials,
 * hashes, session internals, or viewer codes.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './error.js';
import { OperatorSessionError } from '../access/operator-session.js';
import { AccessError } from '../access/tokens.js';
import { LifecycleError } from '../core/lifecycle.js';
import { UndoError } from '../core/undo.js';
import { MatchServiceError } from '../core/match.service.js';
import { EventSequenceConflictError } from '../repositories/match.repo.js';
import { EventValidationError } from '../modules/event/validation.js';
import { SportReplayError } from '../sports/shared/replay.js';
import { SportActionError } from '../sports/shared/reducer.js';

function statusFor(error: OperatorSessionError): number {
  switch (error.code) {
    case 'MATCH_NOT_FOUND':
      return 404;
    case 'OPERATOR_SESSION_REVOKED':
      return 403;
    case 'OPERATOR_SESSION_STALE':
      return 409;
    default:
      return 401;
  }
}

function statusForUndo(error: UndoError): number {
  switch (error.code) {
    case 'MATCH_NOT_FOUND':
    case 'UNDO_TARGET_NOT_FOUND':
      return 404;
    case 'CORRECTION_INVALID':
      return 400;
    default:
      return 409;
  }
}

function statusForEvent(error: EventValidationError): number {
  switch (error.code) {
    case 'EVENT_NOT_FOUND':
    case 'PARENT_EVENT_NOT_FOUND':
      return 404;
    case 'EVENT_HAS_DEPENDENCIES':
      return 409;
    default:
      return 400;
  }
}

function statusForMatch(error: MatchServiceError): number {
  switch (error.code) {
    case 'MATCH_NOT_FOUND':
      return 404;
    case 'OPERATOR_REQUIRED':
      return 401;
    default:
      return 400;
  }
}

function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof OperatorSessionError) {
    return new ApiError(statusFor(error), error.code, error.message);
  }
  if (error instanceof AccessError) {
    return new ApiError(error.code === 'MATCH_NOT_FOUND' ? 404 : 409, error.code, error.message);
  }
  if (error instanceof LifecycleError) {
    return new ApiError(409, error.code, error.message);
  }
  if (error instanceof UndoError) {
    return new ApiError(statusForUndo(error), error.code, error.message);
  }
  if (error instanceof MatchServiceError) {
    return new ApiError(statusForMatch(error), error.code, error.message);
  }
  if (error instanceof EventSequenceConflictError) {
    return new ApiError(409, error.code, error.message);
  }
  if (error instanceof EventValidationError) {
    return new ApiError(statusForEvent(error), error.code, error.message);
  }
  if (error instanceof SportReplayError) {
    return new ApiError(
      error.code === 'CORRECTION_REPLAY_MISMATCH' ? 409 : 500,
      error.code,
      error.message,
    );
  }
  if (error instanceof SportActionError) {
    return new ApiError(409, error.code, error.message);
  }
  return null;
}

/** Express middleware placed after routes and before the generic handler. */
export function domainErrorHandler(
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const mapped = toApiError(error);
  next(mapped ?? error);
}

export { toApiError };
