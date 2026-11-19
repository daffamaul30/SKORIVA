/**
 * T-31.7 — Operator action hook: socket-only, no optimistic state, resync on 409.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOperatorAction } from '@/features/match-session/hooks/use-operator-action';
import { useMatchSession } from '@/features/match-session/store/match-session.store';
import { createSocketClient } from '@/lib/realtime/socket-client';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { FakeSocket } from '../support/fake-socket';

const store = useMatchSession;

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

beforeEach(() => {
  store.getState().reset();
  store.getState().startSession('m-1', 'operator');
  store.getState().setConnection('connected');
  store.getState().setOperatorState({ active: true });
});

afterEach(() => {
  store.getState().reset();
  vi.restoreAllMocks();
});

describe('send', () => {
  it('sends over Socket.IO with txId and expectedVersion', async () => {
    const { socket, client } = setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    store.getState().applySnapshot({
      matchId: 'm-1',
      version: 4,
      state: {
        version: 4,
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
      display: {
        matchStatus: 'live',
        resultDecision: 'undecided',
        teams: { home: { name: 'A' }, away: { name: 'B' } },
        score: { home: 0, away: 0 },
        period: { index: 1, label: 'Q1' },
      },
      serverTs: new Date().toISOString(),
    });

    const { result } = renderHook(() => useOperatorAction({ socket: client, matchId: 'm-1' }));

    const pending = result.current.send({
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });

    const emit = socket.lastEmit();
    expect(emit.event).toBe('match:action');
    expect(emit.payload).toMatchObject({
      matchId: 'm-1',
      type: 'score.change',
      payload: { side: 'home', points: 2 },
      expectedVersion: 4,
    });
    expect((emit.payload as { txId: string }).txId.length).toBeGreaterThan(0);

    socket.respondAck({ version: 5, txId: (emit.payload as { txId: string }).txId });

    await expect(pending).resolves.toMatchObject({ ok: true, version: 5 });

    // B-06: no REST fallback for operational actions.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not mutate authoritative state on success', async () => {
    const { socket, client } = setup();
    const { result } = renderHook(() => useOperatorAction({ socket: client, matchId: 'm-1' }));

    const before = store.getState().version;
    const pending = result.current.send({ type: 'score.change', payload: { side: 'home', points: 3 } });
    socket.respondAck({ version: 1, txId: 'tx' });
    await pending;

    expect(store.getState().version).toBe(before);
  });

  it('surfaces VERSION_CONFLICT without inventing state from the ack', async () => {
    const { socket, client } = setup();
    const { result } = renderHook(() => useOperatorAction({ socket: client, matchId: 'm-1' }));

    const before = store.getState().version;

    const pending = result.current.send({
      type: 'score.change',
      payload: { side: 'home', points: 1 },
    });

    // Real backend contract: the ack carries only currentVersion, never a
    // snapshot. Resync happens through `match:error` (tested separately).
    socket.respondAck({
      error: { code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 12 },
    });

    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERSION_CONFLICT');
    expect(outcome.version).toBe(12);
    // No fake state: the store is untouched until an authoritative snapshot.
    expect(store.getState().version).toBe(before);
  });

  it('exposes a safe message and code for other failures', async () => {
    const { socket, client } = setup();
    const { result } = renderHook(() => useOperatorAction({ socket: client, matchId: 'm-1' }));

    const pending = result.current.send({ type: 'clock.pause', payload: {} });
    socket.respondAck({ error: { code: 'FORBIDDEN', message: 'Only the active operator' } });

    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('FORBIDDEN');
    expect(outcome.message).toBe('Anda tidak memiliki izin untuk tindakan ini.');
  });
});

describe('confirmClock', () => {
  it('confirms recovery with the current expectedVersion', async () => {
    const { socket, client } = setup();
    const { result } = renderHook(() => useOperatorAction({ socket: client, matchId: 'm-1' }));

    const pending = result.current.confirmClock(120_000);
    const emit = socket.lastEmit();

    expect(emit.event).toBe('clock.confirm');
    expect(emit.payload).toMatchObject({ matchId: 'm-1', payload: { remainingMs: 120_000 } });

    socket.respondAck({ version: 2, txId: 'tx' });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});
