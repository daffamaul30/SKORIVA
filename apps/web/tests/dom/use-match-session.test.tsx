/**
 * T-31.7 — Match session binding: credential choice, join lifecycle, recovery.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveJoinCredential,
  useMatchSession,
} from '@/features/match-session/hooks/use-match-session';
import { useMatchSession as useMatchSessionStore } from '@/features/match-session/store/match-session.store';
import { SOCKET_EVENTS } from '@/lib/realtime/socket-contract';
import { createSocketClient } from '@/lib/realtime/socket-client';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { FakeSocket } from '../support/fake-socket';

const store = useMatchSessionStore;

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

const DISPLAY = {
  matchStatus: 'live' as const,
  resultDecision: 'undecided' as const,
  teams: { home: { name: 'A' }, away: { name: 'B' } },
  score: { home: 1, away: 0 },
  period: { index: 1, label: 'Q1' },
};

beforeEach(() => {
  store.getState().reset();
});

afterEach(() => {
  store.getState().reset();
  vi.restoreAllMocks();
});

describe('resolveJoinCredential', () => {
  it('prefers the active session credential over the control token', () => {
    expect(
      resolveJoinCredential('operator', {
        controlToken: 'ctl',
        sessionCredential: 'sess',
      }),
    ).toStrictEqual({ token: 'sess' });
  });

  it('falls back to the control token for a first claim', () => {
    expect(resolveJoinCredential('operator', { controlToken: 'ctl' })).toStrictEqual({
      token: 'ctl',
    });
  });

  it('uses the view code for viewers and never a token', () => {
    expect(
      resolveJoinCredential('viewer', { controlToken: 'ctl', viewCode: 'view' }),
    ).toStrictEqual({ viewCode: 'view' });
  });

  it('returns an empty payload when nothing is available', () => {
    expect(resolveJoinCredential('operator', {})).toStrictEqual({});
    expect(resolveJoinCredential('viewer', {})).toStrictEqual({});
  });
});

describe('useMatchSession', () => {
  it('subscribes and applies the authoritative snapshot', () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    act(() => {
      socket.serverEmit(SOCKET_EVENTS.snapshot, {
        matchId: 'm-1',
        version: 6,
        state: {
          version: 6,
          period: { index: 1, label: 'Q1', status: 'active' },
          clock: {
            mode: 'timed',
            remainingMs: 60_000,
            isRunning: true,
            anchorServerTs: 0,
            lastDurableRemainingMs: 60_000,
            lastDurableAt: new Date(),
            recoveryPending: false,
          },
          sportState: {},
          flags: { clockExpired: false, periodComplete: false },
        },
        display: DISPLAY,
        serverTs: new Date().toISOString(),
      });
    });

    expect(store.getState().version).toBe(6);
    expect(store.getState().matchId).toBe('m-1');
  });

  it('joins on connect and re-joins after a reconnect', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    expect(socket.sent).toHaveLength(0);

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
    });

    expect(socket.lastEmit().event).toBe(SOCKET_EVENTS.join);
    expect(socket.lastEmit().payload).toStrictEqual({ matchId: 'm-1', token: 'ctl' });
    expect(store.getState().connection).toBe('connected');

    // Reconnect: socket.io fires connect again and the hook resyncs.
    await act(async () => {
      socket.beginReconnect(1);
      expect(store.getState().connection).toBe('reconnecting');

      client.disconnect();
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
    });

    const joins = socket.sent.filter((emit) => emit.event === SOCKET_EVENTS.join);
    expect(joins).toHaveLength(2);
  });

  it('marks the session disconnected when the socket drops', () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'viewer',
        credentials: { viewCode: 'view' },
      }),
    );

    act(() => {
      client.connect();
      socket.respondAck({ ok: true, role: 'viewer' });
      client.disconnect();
    });

    expect(store.getState().connection).toBe('disconnected');
  });

  it('exposes canOperate=false while disconnected', () => {
    const { socket, client } = setup();

    const { result } = renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { sessionCredential: 'sess' },
      }),
    );

    act(() => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      socket.serverEmit(SOCKET_EVENTS.operatorState, { active: true });
    });

    expect(result.current.canOperate).toBe(true);

    act(() => {
      client.disconnect();
    });

    expect(result.current.canOperate).toBe(false);
  });

  it('records a rejected join without crashing', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'viewer',
        credentials: { viewCode: 'bad' },
      }),
    );

    await act(async () => {
      client.connect();
      socket.respondAck({
        error: { code: 'VIEW_CODE_INVALID', message: 'Viewer code is not valid for this match.' },
      });
    });

    expect(store.getState().lastError?.code).toBe('VIEW_CODE_INVALID');
    expect(store.getState().lastError?.message).toBe(
      'Tautan viewer tidak valid untuk pertandingan ini.',
    );
  });

  it('unsubscribes on unmount', () => {
    const { socket, client } = setup();

    const { unmount } = renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    unmount();

    act(() => {
      socket.serverEmit(SOCKET_EVENTS.snapshot, {
        matchId: 'm-1',
        version: 99,
        matchStatus: 'live',
        resultDecision: 'undecided',
        display: DISPLAY,
        serverTs: new Date().toISOString(),
      });
    });

    expect(store.getState().version).toBe(0);
  });
});

describe('join guard (R2)', () => {
  function joins(socket: FakeSocket): number {
    return socket.sent.filter((emit) => emit.event === SOCKET_EVENTS.join).length;
  }

  it('deduplicates concurrent joins for the same session', async () => {
    const { socket, client } = setup();

    const { result } = renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    await act(async () => {
      // Two overlapping join calls before any ack arrives.
      const first = result.current.join();
      const second = result.current.join();

      expect(joins(socket)).toBe(1);

      socket.respondAck({ ok: true, role: 'operator' });
      await Promise.all([first, second]);
    });

    expect(joins(socket)).toBe(1);
  });

  it('does not stack joins on repeated connect events', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    await act(async () => {
      client.connect();
      // socket.io can emit connect again on a fast transport upgrade.
      client.connect();
      client.connect();

      expect(joins(socket)).toBe(1);

      socket.respondAck({ ok: true, role: 'operator' });
    });

    expect(joins(socket)).toBe(1);
  });

  it('allows a fresh join after a disconnect that happened before the ack', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    await act(async () => {
      client.connect();
      expect(joins(socket)).toBe(1);

      // Disconnect while the first join is still in flight.
      client.disconnect();
    });

    // Reconnect: the guard was invalidated, so a new join is emitted.
    await act(async () => {
      client.connect();
      expect(joins(socket)).toBe(2);
      socket.respondAck({ ok: true, role: 'operator' });
    });

    expect(store.getState().connection).toBe('connected');
  });

  it('re-joins correctly across rapid disconnect/reconnect cycles', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { sessionCredential: 'sess' },
      }),
    );

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      client.disconnect();
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
      client.disconnect();
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
    });

    expect(joins(socket)).toBe(3);
    expect(store.getState().connection).toBe('connected');
  });

  it('uses the session credential for reconnect joins', async () => {
    const { socket, client } = setup();

    renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl', sessionCredential: 'sess' },
      }),
    );

    await act(async () => {
      client.connect();
      socket.respondAck({ ok: true, role: 'operator' });
    });

    expect(socket.lastEmit().payload).toStrictEqual({ matchId: 'm-1', token: 'sess' });
  });

  it('registers socket listeners exactly once', () => {
    const { socket, client } = setup();

    const { rerender } = renderHook(() =>
      useMatchSession({
        socket: client,
        matchId: 'm-1',
        role: 'operator',
        credentials: { controlToken: 'ctl' },
      }),
    );

    rerender();
    rerender();

    // One subscription per event regardless of re-renders.
    expect(socket.registrations.get(SOCKET_EVENTS.snapshot)).toBe(1);
    expect(socket.registrations.get(SOCKET_EVENTS.patch)).toBe(1);
    expect(socket.registrations.get(SOCKET_EVENTS.clock)).toBe(1);
    expect(socket.registrations.get('connect')).toBe(1);
    expect(socket.registrations.get('disconnect')).toBe(1);
  });
});
