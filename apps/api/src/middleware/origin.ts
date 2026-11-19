/**
 * Origin validation for state-changing requests (T-10).
 *
 * SameSite=Lax is not the only CSRF protection. Browsers send `Origin` on
 * cross-origin unsafe requests; reject any present Origin that is not the
 * configured web origin. Requests without an Origin header (non-browser
 * clients) are allowed and still require valid credentials where applicable.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireTrustedOrigin(allowedOrigin: string) {
  const normalizedAllowedOrigin = new URL(allowedOrigin).origin;

  return (request: Request, _response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get('origin');

    if (!origin) {
      next();
      return;
    }

    try {
      if (new URL(origin).origin === normalizedAllowedOrigin) {
        next();
        return;
      }
    } catch {
      // Invalid Origin values are rejected below.
    }

    next(new ApiError(403, 'UNTRUSTED_ORIGIN', 'Request origin is not allowed.'));
  };
}
