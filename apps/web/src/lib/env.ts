/**
 * Frontend environment validation (T-31.1).
 *
 * Two distinct sources on purpose:
 *
 * - **Server-only** (`BACKEND_URL`): read from `process.env` inside the Next.js
 *   server runtime. It is consumed by `next.config.ts` rewrites so the browser
 *   only ever talks to relative `/api/*` paths. A non-`NEXT_PUBLIC_` variable is
 *   never inlined into the client bundle.
 * - **Browser** (`NEXT_PUBLIC_SOCKET_URL`): the only Next.js-public value in
 *   the app. Next.js statically inlines `process.env.NEXT_PUBLIC_*` accesses, so
 *   it MUST be read via the direct member expression below.
 *
 * No secret or credential belongs in either variable.
 */

import { z } from 'zod';

/** Rejects non-HTTP(S) values and anything that is not an absolute URL. */
const httpUrlSchema = z
  .string({ required_error: 'must be provided', invalid_type_error: 'must be a string' })
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL')
  .transform((value) => value.replace(/\/+$/, ''));

export const backendUrlSchema = httpUrlSchema;
export const socketUrlSchema = httpUrlSchema;

export type BackendUrl = z.infer<typeof backendUrlSchema>;
export type SocketUrl = z.infer<typeof socketUrlSchema>;

/** Parse a value and throw a single, actionable error message. */
function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: string | undefined,
  name: string,
): z.infer<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const reason = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment variable ${name}: ${reason}.`);
  }

  return result.data;
}

/** Only the variables this module reads; `ProcessEnv` itself requires NODE_ENV. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Server-side backend origin used by the REST proxy. */
export function readBackendUrl(source: EnvSource = process.env): BackendUrl {
  return parseOrThrow(backendUrlSchema, source.BACKEND_URL, 'BACKEND_URL');
}

/** Public Socket.IO origin; safe to expose because it carries no credentials. */
export function readSocketUrl(source: EnvSource = process.env): SocketUrl {
  return parseOrThrow(socketUrlSchema, source.NEXT_PUBLIC_SOCKET_URL, 'NEXT_PUBLIC_SOCKET_URL');
}

/**
 * Next.js inlines `process.env.NEXT_PUBLIC_*` only for literal member access,
 * so the browser value is read exactly like this and nowhere else.
 */
export function readPublicSocketUrl(): SocketUrl {
  return parseOrThrow(socketUrlSchema, process.env.NEXT_PUBLIC_SOCKET_URL, 'NEXT_PUBLIC_SOCKET_URL');
}

/** Path prefix for every REST call; the proxy forwards it unchanged. */
export { API_BASE_PATH } from './api/base-path';
