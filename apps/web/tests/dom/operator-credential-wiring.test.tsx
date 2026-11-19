/**
 * T-31 remediation C1 + H1 — integration tests.
 *
 * These exercise the real wiring: a rendered `useMatchSession` against a fake
 * socket, the operator credential store, the match-session store, the REST
 * lifecycle service, and the automatic query-cache isolation.
 *
 * They are deliberately integration-shaped: no test asserts a store setter in
 * isolation, because that is exactly how C1 slipped through the first review.
 */

import { QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMatchSession } from '@/features/match-session/hooks/use-match-session';
import { installOperatorCacheIsolation } from '@/features/match-session/operator-cache-isolation';
import { adoptOperatorSession } from '@/features/match-session/operator-session-adoption';
import { useMatchSession as useMatchSessionStore } from '@/features/match-session/store/match-session.store';
import { startMatch } from '@/features/matches/services/lifecycle';
import { SOCKET_EVENTS } from '@/lib/realtime/socket-contract';
import { createSocketClient } from '@/lib/realtime/socket-client';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { queryKeys } from '@/lib/query/query-keys';
import {
  getSessionCredential,
  useOperatorCredentials,
} from '@/lib/store/operator-credentials.store';
import { FakeSocket } from '../support/fake-socket';

const credentials = useOperatorCredentials;
const session = useMatchSessionStore;
const EXPIRES = '9999-12-31T23:59:59.999Z';

const DISPLAY = {
  matchStatus: 'live' as const,
  resultDecision: 'undecided' as const,
  teams: { home: { name: 'A' }, away: { name: 'B' } },
  score: { home: 0, away: 0 },
  period: { index: 1, label: 'Q1' },
};

function operatorSnapshot(version: number) {
  return {
    matchId: 'm-1',
    version,
    state: {
      version,
      period: { index: 1, label: 'Q1', status: 'active' as const },
      clock: {
        mode: 'timed' as const,
        remainingMs: 600_000,
        isRunning: true,
        anchorServerTs: 0,
        lastDurableRemainingMs: 600_000,
        lastDurableAt: new Date('2026-11-19T10:00:00.000Z'),
        recoveryPending: false,
      },
      sportState: {},
      flags: { clockExpired: false, periodComplete: false },
    },
    display: DISPLAY,
    serverTs: '2026-11-19T10:00:00.000Z',
  };
}

function setup(): { socket: FakeSocket; client: SocketClient } {
  let fake: FakeSocket | undefined;
  const client = createSocketClient({
    url: 'http://localhost:4000',
    factory: (url, options) => {
      fake = new FakeSocket(url, options);
      return fake;
    },
  });

  if (!fake) throw new Error('socket not created');
  return { socket: fake, client };
}

function renderOperatorSession(client: SocketClient) {
  return renderHook(() =>
    useMatchSession({
      socket: client,
      matchId: 'm-1',
      role: 'operator',
      credentials: { controlToken: 'ctl-1' },
    }),
  );
}

beforeEach(() => {
  credentials.getState().clearCredentials();
  session.getState().reset();
});

afterEach(() => {
  credentials.getState().clearCredentials();
  session.getState().reset();
  vi.restoreAllMocks();
});

/* ------------------------------- C1 ------------------------------- */

describe('C1 — operator:session wiring', () => {
  it('fills the session credential from the private operator:session event', async () => {
    const { socket, client } = setup();
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });

    renderOperatorSession(client);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorSession, {
        matchId: 'm-1',
        sessionId: 's-1',
        credential: 'sess-1',
        expiresAt: EXPIRES,
      });
    });

    expect(credentials.getState().sessionCredential).toBe('sess-1');
    expect(credentials.getState().sessionId).toBe('s-1');
    // Ownership is never overwritten by the session credential.
    expect(credentials.getState().controlToken).toBe('ctl-1');
  });

  it('keeps the control token when the session credential arrives', async () => {
    const { socket, client } = setup();
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    renderOperatorSession(client);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorSession, {
        matchId: 'm-1',
        sessionId: 's-1',
        credential: 'sess-1',
        expiresAt: EXPIRES,
      });
    });

    expect(credentials.getState().controlToken).toBe('ctl-1');
    expect(credentials.getState().sessionCredential).not.toBe('ctl-1');
  });

  it('sends the fresh session credential as X-Operator-Session on REST lifecycle', async () => {
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: EXPIRES,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 2, txId: 'tx-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Read at call time — never captured at import or in a stale closure.
    await startMatch({
      matchId: 'm-1',
      txId: 'tx-1',
      expectedVersion: 1,
      sessionCredential: getSessionCredential() ?? '',
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Operator-Session')).toBe('sess-1');
  });

  it('does not overwrite the session credential on control-token rotation', () => {
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: EXPIRES,
    });

    credentials.getState().rotateControlToken({ matchId: 'm-1', controlToken: 'ctl-2' });

    expect(credentials.getState().controlToken).toBe('ctl-2');
    expect(credentials.getState().sessionCredential).toBe('sess-1');
  });

  it('replaces the session credential on a successful handover', () => {
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-old',
      credential: 'sess-old',
      expiresAt: EXPIRES,
    });

    const kind = adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-new',
      credential: 'sess-new',
      expiresAt: EXPIRES,
    });

    expect(kind).toBe('handover');
    expect(credentials.getState().sessionId).toBe('s-new');
    expect(credentials.getState().sessionCredential).toBe('sess-new');
    expect(credentials.getState().controlToken).toBe('ctl-1');
  });

  it('ignores a reconnect echo that carries no credential', () => {
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: EXPIRES,
    });

    const kind = adoptOperatorSession({
      matchId: 'm-1',
      sessionId: 's-1',
      expiresAt: EXPIRES,
    });

    expect(kind).toBe('ignored');
    expect(credentials.getState().sessionCredential).toBe('sess-1');
  });

  it('clears the session credential on operator:state active:false', async () => {
    const { socket, client } = setup();
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    renderOperatorSession(client);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorSession, {
        matchId: 'm-1',
        sessionId: 's-1',
        credential: 'sess-1',
        expiresAt: EXPIRES,
      });
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: true });
    });

    expect(credentials.getState().sessionCredential).toBe('sess-1');

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: false });
    });

    // Session proof gone; ownership survives so the operator can reclaim.
    expect(credentials.getState().sessionCredential).toBeNull();
    expect(credentials.getState().sessionId).toBeNull();
    expect(credentials.getState().controlToken).toBe('ctl-1');
    expect(session.getState().operatorActive).toBe(false);
  });

  it('does not clear credentials for a viewer receiving operator:state', async () => {
    const { socket, client } = setup();
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'viewer',
        credentials: { viewCode: 'view-1' },
      }),
    );

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'viewer' });
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: false });
    });

    expect(credentials.getState().controlToken).toBe('ctl-1');
  });

  it('clears the cache automatically when the session is revoked', async () => {
    const queryClient = new QueryClient();
    const dispose = installOperatorCacheIsolation(queryClient);
    const { socket, client } = setup();

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    renderOperatorSession(client);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorSession, {
        matchId: 'm-1',
        sessionId: 's-1',
        credential: 'sess-1',
        expiresAt: EXPIRES,
      });
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: true });
    });

    queryClient.setQueryData(queryKeys.matches.events('m-1'), { events: [{ seq: 1 }] });
    queryClient.setQueryData(queryKeys.matches.result('m-1'), { matchStatus: 'live' });

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: false });
    });

    expect(queryClient.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    // Public viewer data is not operator-scoped and must survive.
    expect(queryClient.getQueryData(queryKeys.matches.result('m-1'))).toBeDefined();

    dispose();
  });

  it('never stores the viewer code in the credential store', async () => {
    const { socket, client } = setup();
    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    renderOperatorSession(client);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorSession, {
        matchId: 'm-1',
        sessionId: 's-1',
        credential: 'sess-1',
        expiresAt: EXPIRES,
      });
    });

    const state = credentials.getState() as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty('viewCode');
    expect(JSON.stringify(state)).not.toContain('view-1');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

/* ------------------------------- H1 ------------------------------- */

describe('H1 — realtime VERSION_CONFLICT resync', () => {
  async function mountOperatorWithSnapshot(socket: FakeSocket, client: SocketClient, version = 4) {
    renderOperatorSession(client);
    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.snapshot, operatorSnapshot(version));
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: true });
    });
  }

  it('applies the authoritative snapshot from match:error', async () => {
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 4);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'expectedVersion is stale.',
        currentVersion: 9,
        snapshot: operatorSnapshot(9),
      });
    });

    expect(session.getState().version).toBe(9);
    expect(session.getState().lastError?.code).toBe('VERSION_CONFLICT');
  });

  it('keeps the error available to the caller while resyncing', async () => {
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 4);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'expectedVersion is stale.',
        currentVersion: 9,
        snapshot: operatorSnapshot(9),
      });
    });

    expect(session.getState().lastError).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 9,
    });
  });

  it('rejects a stale snapshot', async () => {
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 9);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'stale',
        currentVersion: 4,
        snapshot: operatorSnapshot(4),
      });
    });

    expect(session.getState().version).toBe(9);
    // The error itself is still recorded.
    expect(session.getState().lastError?.code).toBe('VERSION_CONFLICT');
  });

  it('does not fabricate state when VERSION_CONFLICT has no snapshot', async () => {
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 4);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'stale',
        currentVersion: 12,
      });
    });

    expect(session.getState().version).toBe(4);
    expect(session.getState().lastError?.code).toBe('VERSION_CONFLICT');
  });

  it('ignores a malformed snapshot instead of corrupting state', async () => {
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 4);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'stale',
        snapshot: { nonsense: true },
      });
    });

    expect(session.getState().version).toBe(4);
  });

  it('never falls back to REST during a resync', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { socket, client } = setup();
    await mountOperatorWithSnapshot(socket, client, 4);

    await act(async () => {
      socket.serverEmit(SOCKET_EVENTS.error, {
        code: 'VERSION_CONFLICT',
        message: 'stale',
        snapshot: operatorSnapshot(9),
      });
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
