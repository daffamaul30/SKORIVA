/**
 * Global error handling for the API (T-04).
 *
 * Every error response has the same shape:
 *   { code: string, message: string }
 *
 * Codes are stable English identifiers for clients; user-facing copy is
 * produced by the frontend in Bahasa Indonesia (NFR-14).
 */

import type { NextFunction, Request, Response } from 'express';

/** Application error carrying an HTTP status and a stable machine code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ErrorBody {
  code: string;
  message: string;
}

/** Convert any thrown value to the public error body without leaking internals. */
function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }

  // express.json() rejects malformed JSON with a SyntaxError carrying `body`.
  if (error instanceof SyntaxError && 'body' in error) {
    return {
      status: 400,
      body: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' },
    };
  }

  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  };
}

/** 404 handler for unmatched routes. */
export function notFoundHandler(_request: Request, _response: Response, next: NextFunction): void {
  next(new ApiError(404, 'NOT_FOUND', 'Route not found.'));
}

/**
 * Express 5 error middleware. Must keep all four arguments to be recognised as
 * an error handler.
 */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }

  const { status, body } = toErrorBody(error);

  if (status >= 500) {
    console.error('[skoriva-api] unhandled error', error);
  }

  response.status(status).json(body);
}
