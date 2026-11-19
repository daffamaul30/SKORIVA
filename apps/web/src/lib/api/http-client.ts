/**
 * Same-origin REST client (T-31.2).
 *
 * Design constraints:
 * - every path is relative (`/api/...`) so it goes through the Next.js proxy;
 * - `credentials: 'include'` so the `SameSite=Lax` account cookie is sent;
 * - the operator session proof is a dedicated `sessionCredential` option, never
 *   a generic headers bag, so callers cannot mix up credentials;
 * - nothing is persisted and nothing sensitive is logged.
 *
 * Errors are normalised to `ApiClientError` with a safe Bahasa Indonesia
 * message and the original backend `code`.
 */

import {
  ApiClientError,
  CLIENT_ERROR_CODES,
} from './api-error';
import { endpoints } from './endpoints';

/** Operator session proof header (R-01), from `apps/api/src/access/operator-session.ts`. */
export const OPERATOR_SESSION_HEADER = 'X-Operator-Session';
/** Header name taken from `apps/api/src/middleware/viewer-access.ts` (R-03). */
export const VIEW_CODE_HEADER = 'X-View-Code';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** JSON body; serialised with `JSON.stringify`. */
  body?: unknown;
  /** Query string values; `undefined` entries are skipped. */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /**
   * Operator session credential (R-01). Sent as `X-Operator-Session`.
   * This is the operator *session* credential, never the control token.
   */
  sessionCredential?: string;
  /**
   * Public viewer code. Sent as `X-View-Code` instead of `?code=` so it stays
   * out of URLs, referrers, and access logs (R-03).
   */
  viewerCode?: string;
  /** Caller-owned cancellation. */
  signal?: AbortSignal;
}

interface BackendErrorBody {
  code: string;
  message: string;
  currentVersion?: number;
  snapshot?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrow `{ code, message }` without trusting the rest of the body. */
function readErrorBody(value: unknown): BackendErrorBody | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  const message = value.message;
  if (typeof code !== 'string' || code.length === 0) return undefined;
  if (typeof message !== 'string') return undefined;

  const currentVersion = value.currentVersion;
  return {
    code,
    message,
    ...(typeof currentVersion === 'number' ? { currentVersion } : {}),
    ...('snapshot' in value ? { snapshot: value.snapshot } : {}),
  };
}

function buildPath(
  path: string,
  query: ApiRequestOptions['query'],
): string {
  if (!query) return path;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }

  const queryString = search.toString();
  return queryString.length > 0 ? `${path}?${queryString}` : path;
}

function buildHeaders(options: ApiRequestOptions): Headers {
  const headers = new Headers({ Accept: 'application/json' });

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (options.sessionCredential !== undefined && options.sessionCredential.length > 0) {
    headers.set(OPERATOR_SESSION_HEADER, options.sessionCredential);
  }

  if (options.viewerCode !== undefined && options.viewerCode.length > 0) {
    headers.set(VIEW_CODE_HEADER, options.viewerCode);
  }

  return headers;
}

/** Parse the response body once; keep it `unknown` so callers validate. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ApiClientError({
      status: response.status,
      code: CLIENT_ERROR_CODES.invalidJson,
      cause: error,
    });
  }
}

/**
 * Perform a JSON request against the same-origin API and return the parsed body.
 * A non-2xx response becomes an `ApiClientError`; aborts and transport failures
 * are normalised too.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetch(buildPath(path, options.query), {
      method,
      headers: buildHeaders(options),
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // Same-origin proxy: no CORS mode juggling, cache must never hide state.
      cache: 'no-store',
    });
  } catch (error) {
    const aborted =
      (error instanceof DOMException && error.name === 'AbortError') ||
      (isRecord(error) && error.name === 'AbortError');

    throw new ApiClientError({
      status: 0,
      code: aborted ? CLIENT_ERROR_CODES.aborted : CLIENT_ERROR_CODES.network,
      cause: error,
    });
  }

  if (!response.ok) {
    // 204 has no body; a non-2xx with an unreadable body must still be safe.
    const body = await readJson(response).catch(() => undefined);
    const backendError = readErrorBody(body);

    throw new ApiClientError({
      status: response.status,
      code: backendError?.code ?? CLIENT_ERROR_CODES.invalidErrorBody,
      ...(backendError ? { backendMessage: backendError.message } : {}),
      ...(backendError?.currentVersion !== undefined
        ? { currentVersion: backendError.currentVersion }
        : {}),
      ...(backendError && 'snapshot' in backendError
        ? { snapshot: backendError.snapshot }
        : {}),
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await readJson(response)) as T;
}

/** Convenience wrappers; they keep the same option shape. */
export const apiClient = {
  get: <T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST', ...(body !== undefined ? { body } : {}) }),
  patch: <T>(
    path: string,
    body?: unknown,
    options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ) => apiRequest<T>(path, { ...options, method: 'PATCH', ...(body !== undefined ? { body } : {}) }),
} as const;

/** Re-exported so feature services do not re-derive paths. */
export { endpoints };
