/**
 * Auth REST service (T-31.4).
 *
 * The session is an httpOnly `SameSite=Lax` cookie set by the backend, so this
 * module never reads, stores, or returns a token. Calling code must not persist
 * anything from these responses.
 */

import { apiClient } from '@/lib/api/http-client';
import { endpoints } from '@/lib/api/endpoints';
import type {
  AccountSession,
  LoginAccountInput,
  RegisterAccountInput,
  RegisterAccountResult,
} from './auth.types';

/** `POST /api/auth/register` → 201 `PublicAccount` (no cookie set). */
export async function registerAccount(input: RegisterAccountInput): Promise<RegisterAccountResult> {
  const account = await apiClient.post<AccountSession>(endpoints.auth.register(), input);

  return { account, sessionStarted: false };
}

/** `POST /api/auth/login` → 200 `PublicAccount` + `Set-Cookie`. */
export async function loginAccount(input: LoginAccountInput): Promise<AccountSession> {
  return apiClient.post<AccountSession>(endpoints.auth.login(), input);
}

/** `POST /api/auth/logout` → 204; clears the cookie server-side. */
export async function logoutAccount(): Promise<void> {
  await apiClient.post<void>(endpoints.auth.logout());
}

/** `GET /api/auth/me` → 200 `PublicAccount`; 401 `UNAUTHENTICATED` when signed out. */
export async function getCurrentSession(): Promise<AccountSession> {
  return apiClient.get<AccountSession>(endpoints.auth.me());
}
