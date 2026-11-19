/**
 * Viewer access middleware (T-29, B-08 / R-03).
 *
 * Accepts the viewer code from `?code=` or `X-View-Code`. The code is validated
 * together with the match id against the stored hash. The plaintext code is
 * never logged or echoed.
 */

import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { resolveViewerAccess } from '../access/guard.js';
import { ApiError } from './error.js';

export const VIEW_CODE_HEADER = 'x-view-code';

function readViewCode(request: Request): string | undefined {
  const query = request.query.code;
  if (typeof query === 'string' && query.trim().length > 0) return query;

  const header = request.get(VIEW_CODE_HEADER);
  if (header && header.trim().length > 0) return header;

  return undefined;
}

export async function requireViewerAccess(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const viewCode = readViewCode(request);

    if (!viewCode) {
      throw new ApiError(401, 'VIEW_CODE_REQUIRED', 'A viewer code is required.');
    }

    if (typeof request.params.matchId !== 'string') {
      throw new ApiError(403, 'VIEW_CODE_INVALID', 'Viewer code is not valid for this match.');
    }

    const grant = await resolveViewerAccess(request.params.matchId, viewCode, env.TOKEN_PEPPER);

    if (!grant) {
      throw new ApiError(403, 'VIEW_CODE_INVALID', 'Viewer code is not valid for this match.');
    }

    request.match = grant.match;
    next();
  } catch (error) {
    next(error);
  }
}
