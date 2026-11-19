/**
 * Lifecycle service tests (T-31.4).
 *
 * Every lifecycle call must send `{ txId, expectedVersion }` in the body and the
 * session proof only in the `X-Operator-Session` header.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelMatch,
  correctResult,
  discardResult,
  finishMatch,
  reopenMatch,
  restoreResult,
  saveResult,
  startMatch,
} from '@/features/matches/services/lifecycle';
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

const LIFECYCLE_OK = {
  version: 4,
  txId: 'tx-1',
  matchStatus: 'live',
  resultDecision: 'undecided',
};

const baseInput = {
  matchId: 'm-1',
  txId: 'tx-1',
  expectedVersion: 3,
  sessionCredential: 'session-secret',
};

type ActionPath =
  | 'start'
  | 'finish'
  | 'cancel'
  | 'reopen'
  | 'save-result'
  | 'discard-result'
  | 'restore-result';

const ACTIONS: Array<{ path: ActionPath; call: typeof startMatch }> = [
  { path: 'start', call: startMatch },
  { path: 'finish', call: finishMatch },
  { path: 'cancel', call: cancelMatch },
  { path: 'reopen', call: reopenMatch },
  { path: 'save-result', call: saveResult },
  { path: 'discard-result', call: discardResult },
  { path: 'restore-result', call: restoreResult },
];

describe.each(ACTIONS)('$path', ({ path, call }) => {
  it(`posts to /api/matches/:id/${path} with txId, expectedVersion and the session header`, async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/${path}`, ({ request, params }) => {
        expect(params.id).toBe('m-1');
        expect(request.headers.get('X-Operator-Session')).toBe('session-secret');
        return HttpResponse.json(LIFECYCLE_OK);
      }),
    );

    const response = await call(baseInput);

    expect(response.version).toBe(4);
    expect(bridge.last().method).toBe('POST');
    // Body carries only the concurrency guards — never the credential.
    expect(bridge.last().body).toStrictEqual({ txId: 'tx-1', expectedVersion: 3 });
    expect(JSON.stringify(bridge.last().body)).not.toContain('session-secret');
    // The credential must not leak into the URL either.
    expect(bridge.last().relativePath).not.toContain('session-secret');
  });
});

describe('correct result', () => {
  it('sends reason and a sport-specific correction', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/correct-result`, () =>
        HttpResponse.json({
          version: 9,
          txId: 'tx-9',
          before: { homeScore: 70, awayScore: 68 },
          after: { homeScore: 72, awayScore: 68 },
        }),
      ),
    );

    const response = await correctResult({
      ...baseInput,
      txId: 'tx-9',
      expectedVersion: 8,
      reason: 'Kesalahan input skor',
      correction: { homeScore: 72, awayScore: 68 },
    });

    expect(response.after).toStrictEqual({ homeScore: 72, awayScore: 68 });
    expect(bridge.last().body).toStrictEqual({
      txId: 'tx-9',
      expectedVersion: 8,
      reason: 'Kesalahan input skor',
      correction: { homeScore: 72, awayScore: 68 },
    });
    expect(bridge.last().headers.get('X-Operator-Session')).toBe('session-secret');
  });

  it('keeps VALIDATION_ERROR when the reason is missing server-side', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/correct-result`, () =>
        HttpResponse.json(
          { code: 'VALIDATION_ERROR', message: 'reason: Required' },
          { status: 400 },
        ),
      ),
    );

    const error = await correctResult({
      ...baseInput,
      reason: '',
      correction: { homeScore: 1, awayScore: 0 },
    }).catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('lifecycle errors', () => {
  it('preserves VERSION_CONFLICT with currentVersion and snapshot', async () => {
    const snapshot = { version: 12, period: { index: 3 } };
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/finish`, () =>
        HttpResponse.json(
          {
            code: 'VERSION_CONFLICT',
            message: 'expectedVersion is stale; reload the match snapshot.',
            currentVersion: 12,
            snapshot,
          },
          { status: 409 },
        ),
      ),
    );

    const error = await finishMatch({ ...baseInput, expectedVersion: 5 }).catch(
      (caught: unknown) => caught,
    );

    if (isApiClientError(error)) {
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(error.currentVersion).toBe(12);
      expect(error.snapshot).toStrictEqual(snapshot);
    }
  });

  it('preserves OPERATOR_SESSION_REVOKED', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/start`, () =>
        HttpResponse.json(
          { code: 'OPERATOR_SESSION_REVOKED', message: 'Operator session was revoked.' },
          { status: 403 },
        ),
      ),
    );

    const error = await startMatch(baseInput).catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.status).toBe(403);
      expect(error.code).toBe('OPERATOR_SESSION_REVOKED');
      expect(error.message).toBe('Sesi operator sudah dicabut. Hubungkan ulang operator.');
    }
  });

  it('never exposes the credential in errors or logs', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches/:id/cancel`, () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'nope' }, { status: 403 }),
      ),
    );

    const error = await cancelMatch(baseInput).catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.message).not.toContain('session-secret');
      expect(error.stack ?? '').not.toContain('session-secret');
    }
  });
});
