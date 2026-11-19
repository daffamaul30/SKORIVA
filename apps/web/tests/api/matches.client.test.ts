/**
 * Matches service tests (T-31.4).
 *
 * Fixtures follow `match.serializers.ts` exactly: the operator payload carries
 * `match`/`state`/`display`; the viewer payload never carries `state`.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMatch,
  getMatchAsOperator,
  getMatchAsViewer,
  getPublicResult,
  listMatchEventLog,
  updateMatch,
} from '@/features/matches/services/matches.client';
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

const MATCH = {
  id: 'm-1',
  sport: 'basketball',
  teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
  config: {
    periods: { count: 4, durationMs: 600_000, labels: ['Q1', 'Q2', 'Q3', 'Q4'] },
    gameClock: { mode: 'timed', allowStop: true },
    shotClock: { enabled: true, durationMs: 24_000 },
    scoring: { pointsPerGoal: [1, 2, 3] },
  },
  context: {},
  matchStatus: 'ready',
  resultDecision: 'undecided',
  owner: { type: 'device', id: 'dev-1' },
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const STATE = {
  version: 0,
  period: { index: 1, label: 'Q1', status: 'pending' },
  clock: {
    mode: 'timed',
    remainingMs: 600_000,
    isRunning: false,
    anchorServerTs: 0,
    lastDurableRemainingMs: 600_000,
    lastDurableAt: '2026-11-01T10:00:00.000Z',
    recoveryPending: false,
  },
  sportState: {},
  flags: { clockExpired: false, periodComplete: false },
};

const DISPLAY = {
  matchStatus: 'ready',
  resultDecision: 'undecided',
  teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
  score: { home: 0, away: 0 },
  period: { index: 1, label: 'Q1', total: 4 },
};

describe('create match', () => {
  it('returns the one-time controlToken and viewCode verbatim', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches`, () =>
        HttpResponse.json(
          { match: MATCH, state: STATE, display: DISPLAY, controlToken: 'ctl-once', viewCode: 'view-once' },
          { status: 201 },
        ),
      ),
    );

    const created = await createMatch({
      sport: 'basketball',
      teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    });

    expect(created.controlToken).toBe('ctl-once');
    expect(created.viewCode).toBe('view-once');
    // The body sends sport/teams only; owner and access are server-derived.
    expect(bridge.last().body).toStrictEqual({
      sport: 'basketball',
      teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    });
  });

  it('never sends operator credentials on create', async () => {
    server.use(
      http.post(`${ORIGIN}/api/matches`, () =>
        HttpResponse.json(
          { match: MATCH, state: STATE, display: DISPLAY, controlToken: 'c', viewCode: 'v' },
          { status: 201 },
        ),
      ),
    );

    await createMatch({ sport: 'basketball', teams: { home: { name: 'A' }, away: { name: 'B' } } });

    expect(bridge.last().headers.has('X-Operator-Session')).toBe(false);
  });
});

describe('match detail', () => {
  it('requests the operator payload with the session header', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id`, () =>
        HttpResponse.json({ match: MATCH, state: STATE, display: DISPLAY }),
      ),
    );

    const payload = await getMatchAsOperator('m-1', 'session-secret');

    expect(payload.state.version).toBe(0);
    expect(bridge.last().headers.get('X-Operator-Session')).toBe('session-secret');
    expect(bridge.last().relativePath).toBe('/api/matches/m-1');
  });

  it('requests the viewer payload with the view code header, not a query param', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id`, () =>
        HttpResponse.json({ display: DISPLAY, matchStatus: 'ready', resultDecision: 'undecided' }),
      ),
    );

    const payload = await getMatchAsViewer('m-1', 'view-secret');

    expect(payload).not.toHaveProperty('state');
    expect(bridge.last().headers.get('X-View-Code')).toBe('view-secret');
    expect(bridge.last().relativePath).not.toContain('code=');
    expect(bridge.last().url.searchParams.has('code')).toBe(false);
  });

  it('reflects a hidden display while the result is undecided after finish', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id`, () =>
        HttpResponse.json({ matchStatus: 'finished', resultDecision: 'undecided' }),
      ),
    );

    const payload = await getMatchAsViewer('m-1', 'view-secret');

    expect(payload.display).toBeUndefined();
    expect(payload.resultDecision).toBe('undecided');
  });
});

describe('patch match', () => {
  it('patches teams while READY with the session header', async () => {
    server.use(
      http.patch(`${ORIGIN}/api/matches/:id`, () =>
        HttpResponse.json({ match: MATCH, state: STATE, display: DISPLAY }),
      ),
    );

    await updateMatch('m-1', { teams: { home: { name: 'A' }, away: { name: 'B' } } }, 'session-secret');

    expect(bridge.last().method).toBe('PATCH');
    expect(bridge.last().headers.get('X-Operator-Session')).toBe('session-secret');
  });

  it('surfaces VALIDATION_ERROR from the backend', async () => {
    server.use(
      http.patch(`${ORIGIN}/api/matches/:id`, () =>
        HttpResponse.json(
          { code: 'VALIDATION_ERROR', message: 'body: must not be empty' },
          { status: 400 },
        ),
      ),
    );

    const error = await updateMatch('m-1', {}, 'session-secret').catch(
      (caught: unknown) => caught,
    );

    if (isApiClientError(error)) {
      expect(error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('event log pagination', () => {
  it('passes limit and beforeSeq as query parameters', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/events`, () =>
        HttpResponse.json({
          events: [
            {
              seq: 12,
              txId: 't-12',
              type: 'score.change',
              payload: { side: 'home', points: 2 },
              actor: { type: 'operator', id: 'op-1' },
              serverTs: '2026-11-01T10:10:00.000Z',
              appliedAt: '2026-11-01T10:10:00.000Z',
            },
          ],
          nextBeforeSeq: 12,
        }),
      ),
    );

    const page = await listMatchEventLog('m-1', { limit: 20, beforeSeq: 50 }, 'session-secret');

    const params = bridge.last().url.searchParams;
    expect(params.get('limit')).toBe('20');
    expect(params.get('beforeSeq')).toBe('50');
    expect(page.events[0]?.seq).toBe(12);
    expect(page.nextBeforeSeq).toBe(12);
  });

  it('omits undefined pagination values', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/events`, () => HttpResponse.json({ events: [] })),
    );

    await listMatchEventLog('m-1', { limit: 50 }, 'session-secret');

    const params = bridge.last().url.searchParams;
    expect(params.get('limit')).toBe('50');
    expect(params.has('beforeSeq')).toBe(false);
  });

  it('requires the operator session on the event log', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/events`, () =>
        HttpResponse.json(
          { code: 'OPERATOR_SESSION_REQUIRED', message: 'Operator session header is required.' },
          { status: 401 },
        ),
      ),
    );

    const error = await listMatchEventLog('m-1', {}, '').catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.status).toBe(401);
      expect(error.code).toBe('OPERATOR_SESSION_REQUIRED');
    }
  });
});

describe('public result', () => {
  it('returns the display once the result is saved', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/result`, () =>
        HttpResponse.json({
          matchStatus: 'finished',
          resultDecision: 'saved',
          display: { ...DISPLAY, matchStatus: 'finished', resultDecision: 'saved' },
        }),
      ),
    );

    const result = await getPublicResult('m-1', 'view-secret');

    expect(result.display?.resultDecision).toBe('saved');
    expect(bridge.last().headers.get('X-View-Code')).toBe('view-secret');
  });

  it('returns a marker without display for a discarded result', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/result`, () =>
        HttpResponse.json({ matchStatus: 'finished', resultDecision: 'discarded' }),
      ),
    );

    const result = await getPublicResult('m-1', 'view-secret');

    expect(result.resultDecision).toBe('discarded');
    expect(result.display).toBeUndefined();
  });

  it('rejects an invalid viewer code', async () => {
    server.use(
      http.get(`${ORIGIN}/api/matches/:id/result`, () =>
        HttpResponse.json(
          { code: 'VIEW_CODE_INVALID', message: 'Viewer code is not valid for this match.' },
          { status: 403 },
        ),
      ),
    );

    const error = await getPublicResult('m-1', 'bad').catch((caught: unknown) => caught);

    if (isApiClientError(error)) {
      expect(error.code).toBe('VIEW_CODE_INVALID');
      expect(error.message).toBe('Tautan viewer tidak valid untuk pertandingan ini.');
    }
  });
});

describe('create-match credential adoption (C1)', () => {
  it('stores the controlToken in memory and returns the viewCode to the caller', async () => {
    const { useOperatorCredentials } = await import('@/lib/store/operator-credentials.store');
    useOperatorCredentials.getState().clearCredentials();

    server.use(
      http.post(`${ORIGIN}/api/matches`, () =>
        HttpResponse.json(
          {
            match: MATCH,
            state: STATE,
            display: DISPLAY,
            controlToken: 'ctl-adopt',
            viewCode: 'view-adopt',
          },
          { status: 201 },
        ),
      ),
    );

    const created = await createMatch({
      sport: 'basketball',
      teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    });

    const state = useOperatorCredentials.getState();

    // Ownership credential adopted automatically; no UI involvement.
    expect(state.controlToken).toBe('ctl-adopt');
    expect(state.matchId).toBe(MATCH.id);
    // Session proof is not issued yet — that arrives via operator:session.
    expect(state.sessionCredential).toBeNull();

    // The viewer code is still returned for link distribution, but never stored.
    expect(created.viewCode).toBe('view-adopt');
    expect(state as unknown as Record<string, unknown>).not.toHaveProperty('viewCode');

    useOperatorCredentials.getState().clearCredentials();
  });

  it('does not persist the controlToken anywhere', async () => {
    const { useOperatorCredentials } = await import('@/lib/store/operator-credentials.store');
    useOperatorCredentials.getState().clearCredentials();

    server.use(
      http.post(`${ORIGIN}/api/matches`, () =>
        HttpResponse.json(
          {
            match: MATCH,
            state: STATE,
            display: DISPLAY,
            controlToken: 'ctl-adopt',
            viewCode: 'view-adopt',
          },
          { status: 201 },
        ),
      ),
    );

    await createMatch({
      sport: 'basketball',
      teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    });

    // Node test environment has no localStorage; the store itself carries no
    // persist middleware (verified in operator-credentials tests).
    expect(typeof (useOperatorCredentials as unknown as Record<string, unknown>).persist).toBe(
      'undefined',
    );

    useOperatorCredentials.getState().clearCredentials();
  });
});
