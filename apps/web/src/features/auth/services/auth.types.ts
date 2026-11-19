/**
 * Auth wire types (T-31.4).
 *
 * Source of truth: `apps/api/src/modules/auth/auth.service.ts` → `PublicAccount`
 * and `auth.router.ts`. The account is delivered by an httpOnly cookie; the
 * response body never contains a JWT or token.
 */

/** Exactly what `toPublicAccount` returns (Dates arrive as ISO strings). */
export interface AccountSession {
  id: string;
  email: string;
  createdAt: string;
  /**
   * `lastLoginAt` is optional in the Mongoose schema with no default, so the
   * wire value is one of:
   * - absent (never logged in — `undefined` is dropped by `JSON.stringify`);
   * - `null` (explicitly stored as null in an existing document);
   * - an ISO timestamp string.
   *
   * Do not collapse `null` into `undefined`: they are distinct wire states.
   */
  lastLoginAt?: string | null;
}

export interface RegisterAccountInput {
  email: string;
  password: string;
}

export interface LoginAccountInput {
  email: string;
  password: string;
}

/**
 * Semantic result of signing up. The backend does **not** start a session on
 * register, so callers must log in explicitly.
 */
export interface RegisterAccountResult {
  account: AccountSession;
  /** Always false: the backend issues no cookie on `POST /auth/register`. */
  sessionStarted: false;
}
