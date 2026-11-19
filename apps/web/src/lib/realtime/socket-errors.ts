/**
 * Socket error normalisation (T-31.5).
 *
 * The backend uses two error surfaces:
 * - an **ack** `{ error: { code, message, currentVersion? } }` for the requester;
 * - a `match:error` broadcast with the same shape plus an optional `snapshot`.
 *
 * Both become `SocketClientError` with a safe Bahasa Indonesia message while the
 * original `code` is preserved for feature-level handling.
 */

import { CLIENT_ERROR_CODES, safeMessageFor } from '../api/api-error';
import type { AckErrorBody, MatchErrorPayloadShape } from './socket-contract';

export interface SocketClientErrorInit {
  code: string;
  /** Backend English detail; used only when no safe copy exists. */
  backendMessage?: string;
  currentVersion?: number;
  snapshot?: unknown;
  cause?: unknown;
}

export class SocketClientError extends Error {
  readonly code: string;
  readonly currentVersion?: number;
  readonly snapshot?: unknown;

  constructor(init: SocketClientErrorInit) {
    super(safeMessageFor(init.code, init.backendMessage));
    this.name = 'SocketClientError';
    this.code = init.code;
    this.currentVersion = init.currentVersion;
    this.snapshot = init.snapshot;
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }

  /** The caller must resync from the provided snapshot. */
  get isVersionConflict(): boolean {
    return this.code === 'VERSION_CONFLICT';
  }
}

export function isSocketClientError(value: unknown): value is SocketClientError {
  return value instanceof SocketClientError;
}

/** Narrow an ack `error` member without trusting the rest of the payload. */
export function toSocketError(
  body: AckErrorBody | MatchErrorPayloadShape | undefined,
): SocketClientError {
  if (!body || typeof body.code !== 'string') {
    return new SocketClientError({ code: CLIENT_ERROR_CODES.invalidErrorBody });
  }

  return new SocketClientError({
    code: body.code,
    ...(typeof body.message === 'string' ? { backendMessage: body.message } : {}),
    ...(typeof body.currentVersion === 'number' ? { currentVersion: body.currentVersion } : {}),
    ...('snapshot' in body ? { snapshot: body.snapshot } : {}),
  });
}

/** Ack shape used by `match:action`, `clock.confirm`, `match:join`. */
export type AckResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SocketClientError };

/**
 * Interpret a raw ack callback argument.
 *
 * Success shapes differ per event, so `isSuccess` decides; any object carrying an
 * `error` member is a failure.
 */
export function parseAck<T>(
  raw: unknown,
  isSuccess: (value: Record<string, unknown>) => boolean,
): AckResult<T> {
  if (typeof raw !== 'object' || raw === null) {
    return {
      ok: false,
      error: new SocketClientError({ code: CLIENT_ERROR_CODES.invalidErrorBody }),
    };
  }

  const record = raw as Record<string, unknown>;

  if ('error' in record) {
    return {
      ok: false,
      error: toSocketError(record.error as AckErrorBody | undefined),
    };
  }

  if (!isSuccess(record)) {
    return {
      ok: false,
      error: new SocketClientError({ code: CLIENT_ERROR_CODES.invalidErrorBody }),
    };
  }

  return { ok: true, data: record as T };
}
