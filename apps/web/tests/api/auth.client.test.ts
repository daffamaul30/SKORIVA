/**
 * Auth service tests (T-31.4) — MSW fixtures mirror `toPublicAccount`.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getCurrentSession,
  loginAccount,
  logoutAccount,
  registerAccount,
} from '@/features/auth/services/auth.client';
import { isApiClientError } from '@/lib/api/api-error';
import { TEST_ORIGIN, installFetchBridge } from './support/test-fetch';
import type { FetchBridge } from './support/test-fetch';

const ORIGIN = TEST_ORIGIN;
const server = setupServer();
let bridge: FetchBridge;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  bridge = installFetchBridge();
});

afterEach(() => {
  server.resetHandlers();
  bridge.requests.length = 0;
});

afterAll(() => {
  bridge.restore();
  server.close();
});

/** Exactly the shape of `toPublicAccount` (Dates serialised by Express). */
const PUBLIC_ACCOUNT = {
  id: '507f1f77bcf86cd799439011',
  email: 'operator@example.com',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastLoginAt: '2026-11-19T08:30:00.000Z',
};

describe('register', () => {
  it('posts credentials and reports that no session was started', async () => {
    server.use(
      http.post(`${ORIGIN}/api/auth/register`, () =>
        HttpResponse.json({ ...PUBLIC_ACCOUNT, lastLoginAt: undefined }, { status: 201 }),
      ),
    );

    const result = await registerAccount({
      email: 'operator@example.com',
      password: 'rahasia12345',
    });

    expect(bridge.last().relativePath).toBe('/api/auth/register');
    expect(bridge.last().method).toBe('POST');
    expect(bridge.last().body).toStrictEqual({
      email: 'operator@example.com',
      password: 'rahasia12345',
    });
    expect(result.sessionStarted).toBe(false);
    expect(result.account.id).toBe(PUBLIC_ACCOUNT.id);
  });

  it('surfaces EMAIL_ALREADY_REGISTERED with its original code', async () => {
    server.use(
      http.post(`${ORIGIN}/api/auth/register`, () =>
        HttpResponse.json(
          { code: 'EMAIL_ALREADY_REGISTERED', message: 'Email is already registered.' },
          { status: 409 },
        ),
      ),
    );

    const error = await registerAccount({ email: 'a@b.c', password: 'rahasia12345' }).catch(
      (caught: unknown) => caught,
    );

    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.status).toBe(409);
      expect(error.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect(error.message).toBe('Email ini sudah terdaftar.');
    }
  });
});

describe('login / logout / me', () => {
  it('logs in and relies on the cookie, not a token in the body', async () => {
    server.use(
      http.post(
        `${ORIGIN}/api/auth/login`,
        () =>
          HttpResponse.json(PUBLIC_ACCOUNT, {
            status: 200,
            headers: { 'Set-Cookie': 'skoriva_session=jwt; Path=/; HttpOnly; SameSite=Lax' },
          }),
      ),
    );

    const account = await loginAccount({ email: 'operator@example.com', password: 'rahasia12345' });

    expect(account.email).toBe('operator@example.com');
    expect(account).not.toHaveProperty('token');
    expect(account).not.toHaveProperty('password');
    // Sensitive cookie handling stays with the browser: credentials are sent.
    expect(bridge.last().credentials).toBe('include');
  });

  it('rejects bad credentials with INVALID_CREDENTIALS', async () => {
    server.use(
      http.post(`${ORIGIN}/api/auth/login`, () =>
        HttpResponse.json(
          { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
          { status: 401 },
        ),
      ),
    );

    const error = await loginAccount({ email: 'a@b.c', password: 'wrong' }).catch(
      (caught: unknown) => caught,
    );

    if (isApiClientError(error)) {
      expect(error.code).toBe('INVALID_CREDENTIALS');
      expect(error.message).toBe('Email atau password salah.');
    }
  });

  it('logs out with a 204 and no body', async () => {
    server.use(
      http.post(`${ORIGIN}/api/auth/logout`, () => new HttpResponse(null, { status: 204 })),
    );

    await expect(logoutAccount()).resolves.toBeUndefined();
    expect(bridge.last().relativePath).toBe('/api/auth/logout');
  });

  it('reads the current session from the cookie', async () => {
    server.use(http.get(`${ORIGIN}/api/auth/me`, () => HttpResponse.json(PUBLIC_ACCOUNT)));

    const session = await getCurrentSession();

    expect(session.id).toBe(PUBLIC_ACCOUNT.id);
    expect(bridge.last().credentials).toBe('include');
  });

  it('reports a signed-out state as UNAUTHENTICATED', async () => {
    server.use(
      http.get(`${ORIGIN}/api/auth/me`, () =>
        HttpResponse.json(
          { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
          { status: 401 },
        ),
      ),
    );

    const error = await getCurrentSession().catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.status).toBe(401);
      expect(error.code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('lastLoginAt wire shapes', () => {
  it('accepts an absent lastLoginAt (never logged in)', async () => {
    server.use(
      http.get(`${ORIGIN}/api/auth/me`, () =>
        HttpResponse.json({
          id: PUBLIC_ACCOUNT.id,
          email: PUBLIC_ACCOUNT.email,
          createdAt: PUBLIC_ACCOUNT.createdAt,
        }),
      ),
    );

    const session = await getCurrentSession();

    expect(session.lastLoginAt).toBeUndefined();
  });

  it('accepts an explicit null without converting it to undefined', async () => {
    server.use(
      http.get(`${ORIGIN}/api/auth/me`, () =>
        HttpResponse.json({
          id: PUBLIC_ACCOUNT.id,
          email: PUBLIC_ACCOUNT.email,
          createdAt: PUBLIC_ACCOUNT.createdAt,
          lastLoginAt: null,
        }),
      ),
    );

    const session = await getCurrentSession();

    // `null` is a distinct wire state and must survive the round trip.
    expect(session.lastLoginAt).toBeNull();
    expect(session.lastLoginAt).not.toBeUndefined();
  });

  it('accepts a valid ISO timestamp', async () => {
    server.use(
      http.get(`${ORIGIN}/api/auth/me`, () => HttpResponse.json(PUBLIC_ACCOUNT)),
    );

    const session = await getCurrentSession();

    expect(session.lastLoginAt).toBe('2026-11-19T08:30:00.000Z');
    expect(Number.isNaN(Date.parse(session.lastLoginAt ?? ''))).toBe(false);
  });
});
