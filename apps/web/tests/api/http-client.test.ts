/**
 * REST client contract tests (T-31.2).
 *
 * The client is exercised through a real `fetch` against MSW handlers. A thin
 * test bridge records the browser-shaped relative request and forwards an
 * absolute equivalent, because Node's `fetch` has no document origin and MSW
 * binds the native `fetch` before a runtime shim can wrap it.
 *
 * Assertions therefore cover what production code actually sends:
 * relative `/api` paths, `credentials: 'include'`, the operator session header,
 * and the normalised error objects.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isApiClientError, safeMessageFor } from '@/lib/api/api-error';
import type { ApiClientError } from '@/lib/api/api-error';
import { endpoints } from '@/lib/api/endpoints';
import { OPERATOR_SESSION_HEADER, apiClient, apiRequest } from '@/lib/api/http-client';
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
  vi.restoreAllMocks();
  bridge.requests.length = 0;
});

afterAll(() => {
  bridge.restore();
  server.close();
});

describe('request transport', () => {
  it('calls a relative /api path on the same origin', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:matchId`, () => HttpResponse.json({ ok: true })),
    );

    await apiClient.get('/api/matches/abc');

    expect(bridge.last().relativePath).toBe('/api/matches/abc');
    expect(bridge.last().url.origin).toBe(ORIGIN);
  });

  it('uses endpoint definitions instead of ad-hoc strings', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events/:eventId/matches`, () => HttpResponse.json({ groups: [] })),
    );

    await apiClient.get(endpoints.events.matches('evt-1'));

    expect(bridge.last().relativePath).toBe('/api/events/evt-1/matches');
  });

  it('sends credentials: include so the account cookie travels', async () => {
    server.use(http.get(`${ORIGIN}/api/auth/me`, () => HttpResponse.json({ email: 'a@b.c' })));

    await apiClient.get('/api/auth/me');

    expect(bridge.last().credentials).toBe('include');
  });

  it('builds query strings and skips undefined values', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:matchId/events`, () => HttpResponse.json({ events: [] })),
    );

    await apiClient.get('/api/matches/m1/events', {
      query: { limit: 50, beforeSeq: undefined },
    });

    const request = bridge.last();
    expect(request.relativePath).toBe('/api/matches/m1/events?limit=50');
    expect(request.url.searchParams.get('limit')).toBe('50');
    expect(request.url.searchParams.has('beforeSeq')).toBe(false);
  });

  it('serialises a JSON body with POST', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches`, () => HttpResponse.json({ id: 'm1' }, { status: 201 })),
    );

    await apiClient.post('/api/matches', { sport: 'futsal' });

    expect(bridge.last().body).toStrictEqual({ sport: 'futsal' });
  });

  it('returns undefined for 204 responses', async () => {
    server.use(
      http.post(`${ORIGIN}/api/auth/logout`, () => new HttpResponse(null, { status: 204 })),
    );

    await expect(apiClient.post<void>('/api/auth/logout')).resolves.toBeUndefined();
  });
});

describe('operator session header', () => {
  it('sends X-Operator-Session when sessionCredential is provided', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:matchId/start`, () =>
        HttpResponse.json({ version: 3, txId: 't1' }),
      ),
    );

    await apiRequest('/api/matches/m1/start', {
      method: 'POST',
      body: { txId: 't1', expectedVersion: 2 },
      sessionCredential: 'session-secret-value',
    });

    expect(bridge.last().headers.get(OPERATOR_SESSION_HEADER)).toBe('session-secret-value');
  });

  it('omits the header when the credential is absent or empty', async () => {
    server.use(http.get(`${ORIGIN}/api/matches/:matchId`, () => HttpResponse.json({ display: {} })));

    await apiClient.get('/api/matches/m1');
    expect(bridge.last().headers.has(OPERATOR_SESSION_HEADER)).toBe(false);

    await apiClient.get('/api/matches/m1', { sessionCredential: '' });
    expect(bridge.last().headers.has(OPERATOR_SESSION_HEADER)).toBe(false);
  });

  it('exposes no generic header option that could carry credentials', async () => {
    server.use(http.get(`${ORIGIN}/api/matches/:matchId`, () => HttpResponse.json({ display: {} })));

    await apiClient.get('/api/matches/m1', {
      // `headers` is deliberately not part of the contract and must be ignored.
      ...({ headers: { Authorization: 'Bearer leaked' } } as object),
    });

    expect(bridge.last().headers.get('authorization')).toBeNull();
  });
});

describe('error normalisation', () => {
  it('maps UNAUTHENTICATED and keeps the raw code', async () => {
    server.use(
      http.get(`${ORIGIN}/api/auth/me`, () =>
        HttpResponse.json(
          { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
          { status: 401 },
        ),
      ),
    );

    const error = await apiClient.get('/api/auth/me').catch((caught: unknown) => caught);

    expect(isApiClientError(error)).toBe(true);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe('UNAUTHENTICATED');
    expect(apiError.message).toBe(
      'Sesi Anda tidak valid atau sudah berakhir. Silakan masuk kembali.',
    );
  });

  it('maps VALIDATION_ERROR', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches`, () =>
        HttpResponse.json(
          { code: 'VALIDATION_ERROR', message: 'teams.away.name: required' },
          { status: 400 },
        ),
      ),
    );

    const error = (await apiClient
      .post('/api/matches', {})
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Data yang dikirim tidak valid. Periksa kembali isian Anda.');
  });

  it('preserves currentVersion and snapshot on VERSION_CONFLICT', async () => {
    const snapshot = { version: 7, period: { index: 2 } };
    server.use(
      http.post(`${ORIGIN}/api/matches/:matchId/finish`, () =>
        HttpResponse.json(
          {
            code: 'VERSION_CONFLICT',
            message: 'expectedVersion is stale; reload the match snapshot.',
            currentVersion: 7,
            snapshot,
          },
          { status: 409 },
        ),
      ),
    );

    const error = (await apiRequest('/api/matches/m1/finish', {
      method: 'POST',
      body: { txId: 't1', expectedVersion: 5 },
      sessionCredential: 'cred',
    }).catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.status).toBe(409);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.isVersionConflict).toBe(true);
    expect(error.currentVersion).toBe(7);
    expect(error.snapshot).toStrictEqual(snapshot);
  });

  it('keeps an unknown backend code without inventing behaviour', async () => {
    server.use(
      http.get(`${ORIGIN}/api/events`, () =>
        HttpResponse.json({ code: 'SOMETHING_NEW', message: 'backend detail' }, { status: 418 }),
      ),
    );

    const error = (await apiClient
      .get('/api/events')
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.code).toBe('SOMETHING_NEW');
    expect(error.message).toBe(safeMessageFor('SOMETHING_NEW', 'backend detail'));
  });
});

describe('unreadable responses', () => {
  it('normalises an invalid JSON success body', async () => {
    server.use(
      http.get(
        `${ORIGIN}/api/events`,
        () =>
          new HttpResponse('<html>not json</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const error = (await apiClient
      .get('/api/events')
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.code).toBe('INVALID_RESPONSE_BODY');
    expect(error.status).toBe(200);
  });

  it('normalises a non-JSON error body without leaking it', async () => {
    server.use(
      http.get(
        `${ORIGIN}/api/events`,
        () => new HttpResponse('Bad gateway: token=leaked-secret', { status: 502 }),
      ),
    );

    const error = (await apiClient
      .get('/api/events')
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.status).toBe(502);
    expect(error.code).toBe('INVALID_ERROR_BODY');
    expect(error.message).not.toContain('leaked-secret');
    expect(error.message).not.toContain('token=');
  });

  it('normalises a transport failure as NETWORK_ERROR', async () => {
    server.use(http.get(`${ORIGIN}/api/events`, () => HttpResponse.error()));

    const error = (await apiClient
      .get('/api/events')
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
  });

  it('normalises an abort as REQUEST_ABORTED', async () => {
    server.use(http.get(`${ORIGIN}/api/events`, () => HttpResponse.error()));
    const controller = new AbortController();
    controller.abort();

    const error = (await apiClient
      .get('/api/events', { signal: controller.signal })
      .catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.code).toBe('REQUEST_ABORTED');
  });
});

describe('credential hygiene', () => {
  it('never logs the session credential, view code, or cookie', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    server.use(
      http.post(`${ORIGIN}/api/matches/:matchId/cancel`, () =>
        HttpResponse.json({ code: 'STATE_CONFLICT', message: 'conflict detail' }, { status: 409 }),
      ),
    );

    await apiRequest('/api/matches/m1/cancel', {
      method: 'POST',
      body: { txId: 't1', expectedVersion: 1 },
      sessionCredential: 'super-secret-session',
      query: { code: 'view-code-secret' },
    }).catch(() => undefined);

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((entry) => String(entry))
      .join(' ');

    expect(logged).not.toContain('super-secret-session');
    expect(logged).not.toContain('view-code-secret');
  });

  it('keeps error messages and stacks free of the credential', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:matchId/cancel`, () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'nope' }, { status: 403 }),
      ),
    );

    const error = (await apiRequest('/api/matches/m1/cancel', {
      method: 'POST',
      sessionCredential: 'super-secret-session',
    }).catch((caught: unknown) => caught)) as ApiClientError;

    expect(error.message).not.toContain('super-secret-session');
    expect(error.stack ?? '').not.toContain('super-secret-session');
  });
});

describe('endpoint catalogue', () => {
  it('uses the relative /api prefix for every REST endpoint', () => {
    const paths = [
      endpoints.auth.login(),
      endpoints.matches.create(),
      endpoints.matches.detail('m1'),
      endpoints.matches.events('m1'),
      endpoints.matches.result('m1'),
      endpoints.events.list(),
      endpoints.events.children('e1'),
    ];

    for (const path of paths) {
      expect(path.startsWith('/api/')).toBe(true);
      expect(path).not.toMatch(/^https?:/);
    }
  });

  it('encodes identifiers so they cannot escape the path segment', () => {
    expect(endpoints.matches.detail('a/b?c=1')).toBe('/api/matches/a%2Fb%3Fc%3D1');
  });

  it('does not define the unimplemented history endpoint', () => {
    expect(JSON.stringify(endpoints)).not.toContain('history');
  });

  it('covers every match lifecycle route that exists in the backend', () => {
    expect(endpoints.matches.start('m')).toBe('/api/matches/m/start');
    expect(endpoints.matches.finish('m')).toBe('/api/matches/m/finish');
    expect(endpoints.matches.cancel('m')).toBe('/api/matches/m/cancel');
    expect(endpoints.matches.reopen('m')).toBe('/api/matches/m/reopen');
    expect(endpoints.matches.saveResult('m')).toBe('/api/matches/m/save-result');
    expect(endpoints.matches.discardResult('m')).toBe('/api/matches/m/discard-result');
    expect(endpoints.matches.restoreResult('m')).toBe('/api/matches/m/restore-result');
    expect(endpoints.matches.correctResult('m')).toBe('/api/matches/m/correct-result');
    expect(endpoints.matches.claim('m')).toBe('/api/matches/m/claim');
  });
});
