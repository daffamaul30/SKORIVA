/**
 * Operator session proof middleware (T-29, R-01).
 *
 * Reads `X-Operator-Session`, verifies the opaque credential against the stored
 * hash, the match id, expiry, revocation, and the currently active session, and
 * attaches the match to the request. The plaintext credential is never logged.
 */

import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import {
  OPERATOR_SESSION_HEADER,
  OperatorSessionError,
  verifyOperatorSession,
} from '../access/operator-session.js';
import { ApiError } from './error.js';

const STATUS_BY_CODE: Record<string, number> = {
  MATCH_NOT_FOUND: 404,
  OPERATOR_SESSION_INVALID: 401,
  OPERATOR_SESSION_EXPIRED: 401,
  OPERATOR_SESSION_REVOKED: 403,
  OPERATOR_SESSION_STALE: 409,
};

/** Map an operator session error to a stable API error. */
export function toOperatorSessionApiError(error: OperatorSessionError): ApiError {
  const status = STATUS_BY_CODE[error.code] ?? 401;
  return new ApiError(status, error.code, error.message);
}

export async function requireOperatorSession(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const credential = request.get(OPERATOR_SESSION_HEADER);

    if (!credential || credential.trim().length === 0) {
      throw new ApiError(401, 'OPERATOR_SESSION_REQUIRED', 'Operator session header is required.');
    }

    if (typeof request.params.matchId !== 'string') {
      throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found.');
    }

    const verified = await verifyOperatorSession(
      request.params.matchId,
      credential,
      env.TOKEN_PEPPER,
    );

    request.match = verified.match;
    request.operatorSession = verified.session;

    next();
  } catch (error) {
    if (error instanceof OperatorSessionError) {
      next(toOperatorSessionApiError(error));
      return;
    }
    next(error);
  }
}
