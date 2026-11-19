/**
 * T-31.5 — Socket.IO client contract tests.
 *
 * Uses a deterministic fake socket so lifecycle, payload shape, and ack
 * normalisation are asserted without network or timing flake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_EVENTS } from '@/lib/realtime/socket-contract';
import { createSocketClient } from '@/lib/realtime/socket-client';
import type { SocketClient } from '@/lib/realtime/socket-client';
import { isSocketClientError } from '@/lib/realtime/socket-errors';
import { FakeSocket } from '../support/fake-socket';

function setup(options: { ackTimeoutMs?: number } = {}): {
  socket: FakeSocket;
  client: SocketClient;
} {
  let created: FakeSocket | undefined;

  const client = createSocketClient({
    url: 'http://localhost:4000',
    factory: (url, factoryOptions) => {
      created = new FakeSocket(url, factoryOptions);
      return created;
    },
    ...options,
  });

  if (!created) throw new Error('socket was not created');

  return { socket: created, client };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connection lifecycle', () => {
  it('does not connect on creation', () => {
    const { socket } = setup();

    expect(socket.connected).toBe(false);
    expect(socket.options.autoConnect).toBe(false);
  });

  it('connects and disconnects explicitly', () => {
    const { socket, client } = setup();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    client.onConnect(onConnect);
    client.onDisconnect(onDisconnect);

    client.connect();
    expect(socket.connected).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(1);

    client.disconnect();
    expect(socket.connected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith('io client disconnect');
  });

  it('reports reconnection attempts and connection errors', () => {
    const { socket, client } = setup();
    const onReconnecting = vi.fn();
    const onConnectError = vi.fn();

    client.onReconnecting(onReconnecting);
    client.onConnectError(onConnectError);

    socket.beginReconnect(2);
    socket.failConnection('refused');

    expect(onReconnecting).toHaveBeenCalledWith(2);
    expect(onConnectError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('sends no credentials in the connection URL or options', () => {
    const { socket } = setup();

    expect(socket.url).toBe('http://localhost:4000');
    expect(socket.url).not.toContain('token');
    expect(socket.url).not.toContain('code=');
    expect(socket.options).toMatchObject({ withCredentials: false, autoConnect: false });
  });
});

describe('join', () => {
  it('joins as operator with the control token', async () => {
    const { socket, client } = setup();

    const pending = client.join({ matchId: 'm-1', token: 'control-token-value' });

    expect(socket.lastEmit().event).toBe(SOCKET_EVENTS.join);
    expect(socket.lastEmit().payload).toStrictEqual({
      matchId: 'm-1',
      token: 'control-token-value',
    });

    socket.respondAck({ ok: true, role: 'operator' });
    await expect(pending).resolves.toStrictEqual({
      ok: true,
      data: { ok: true, role: 'operator' },
    });
  });

  it('joins as viewer with the view code', async () => {
    const { socket, client } = setup();

    const pending = client.join({ matchId: 'm-1', viewCode: 'view-code-value' });
    socket.respondAck({ ok: true, role: 'viewer' });

    await expect(pending).resolves.toMatchObject({ ok: true, data: { role: 'viewer' } });
    expect(socket.lastEmit().payload).toStrictEqual({
      matchId: 'm-1',
      viewCode: 'view-code-value',
    });
  });

  it('surfaces a rejected join with its backend code', async () => {
    const { socket, client } = setup();

    const pending = client.join({ matchId: 'm-1', token: 'bad' });
    socket.respondAck({
      error: { code: 'OPERATOR_SESSION_INVALID', message: 'Operator credential is not valid.' },
    });

    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OPERATOR_SESSION_INVALID');
      expect(result.error.message).toBe('Sesi operator tidak valid.');
    }
  });
});

describe('actions and acknowledgements', () => {
  it('sends an operational action with txId and expectedVersion', async () => {
    const { socket, client } = setup();

    const pending = client.sendAction({
      matchId: 'm-1',
      type: 'score.change',
      payload: { side: 'home', points: 2 },
      txId: 'tx-1',
      expectedVersion: 4,
    });

    expect(socket.lastEmit().payload).toStrictEqual({
      matchId: 'm-1',
      type: 'score.change',
      payload: { side: 'home', points: 2 },
      txId: 'tx-1',
      expectedVersion: 4,
    });

    socket.respondAck({ version: 5, txId: 'tx-1' });
    await expect(pending).resolves.toStrictEqual({
      ok: true,
      data: { version: 5, txId: 'tx-1' },
    });
  });

  it('preserves currentVersion and snapshot on VERSION_CONFLICT', async () => {
    const { socket, client } = setup();
    const snapshot = { matchId: 'm-1', version: 9, state: {}, display: {}, serverTs: 'now' };

    const pending = client.sendAction({
      matchId: 'm-1',
      type: 'clock.start',
      payload: {},
      txId: 'tx-2',
      expectedVersion: 4,
    });

    socket.respondAck({
      error: {
        code: 'VERSION_CONFLICT',
        message: 'expectedVersion is stale.',
        currentVersion: 9,
        snapshot,
      },
    });

    const result = await pending;

    if (!result.ok) {
      expect(result.error.code).toBe('VERSION_CONFLICT');
      expect(result.error.currentVersion).toBe(9);
      expect(result.error.snapshot).toStrictEqual(snapshot);
      expect(result.error.isVersionConflict).toBe(true);
    } else {
      throw new Error('expected a failure');
    }
  });

  it('keeps FORBIDDEN when a non-operator sends an action', async () => {
    const { socket, client } = setup();

    const pending = client.sendAction({
      matchId: 'm-1',
      type: 'score.change',
      payload: { side: 'home', points: 1 },
      txId: 'tx-3',
      expectedVersion: 0,
    });
    socket.respondAck({
      error: { code: 'FORBIDDEN', message: 'Only the active operator can send actions.' },
    });

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Anda tidak memiliki izin untuk tindakan ini.');
  });

  it('confirms a recovered clock', async () => {
    const { socket, client } = setup();

    const pending = client.confirmClock({
      matchId: 'm-1',
      txId: 'tx-clock',
      expectedVersion: 7,
      payload: { remainingMs: 120_000 },
    });

    expect(socket.lastEmit().event).toBe(SOCKET_EVENTS.clockConfirm);
    socket.respondAck({ version: 8, txId: 'tx-clock' });
    await expect(pending).resolves.toMatchObject({ ok: true, data: { version: 8 } });
  });

  it('rejects a malformed ack instead of trusting it', async () => {
    const { socket, client } = setup();

    const pending = client.sendAction({
      matchId: 'm-1',
      type: 'clock.pause',
      payload: {},
      txId: 'tx-4',
      expectedVersion: 1,
    });
    socket.respondAck({ something: 'else' });

    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('times out when the backend never acknowledges', async () => {
    vi.useFakeTimers();
    const { client } = setup({ ackTimeoutMs: 1_000 });

    const pending = client.ping();
    const assertion = expect(pending).rejects.toSatisfy(
      (error: unknown) => isSocketClientError(error) && error.code === 'ACK_TIMEOUT',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

describe('operator management', () => {
  it('leaves the match', async () => {
    const { socket, client } = setup();

    const pending = client.leave({ matchId: 'm-1' });
    socket.respondAck({ ok: true });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(socket.lastEmit().event).toBe(SOCKET_EVENTS.leave);
  });

  it('creates a handover code', async () => {
    const { socket, client } = setup();

    const pending = client.createHandoverCode({ matchId: 'm-1' });
    socket.respondAck({ code: 'ABC123', expiresAt: '2026-11-19T10:02:00.000Z' });

    const result = await pending;
    expect(result.ok && result.data.code).toBe('ABC123');
  });

  it('accepts a handover code', async () => {
    const { socket, client } = setup();

    const pending = client.acceptHandoverCode({ matchId: 'm-1', code: 'ABC123' });
    expect(socket.lastEmit().payload).toStrictEqual({ matchId: 'm-1', code: 'ABC123' });

    socket.respondAck({ active: true });
    await expect(pending).resolves.toMatchObject({ ok: true, data: { active: true } });
  });

  it('reports an expired handover code', async () => {
    const { socket, client } = setup();

    const pending = client.acceptHandoverCode({ matchId: 'm-1', code: 'OLD' });
    socket.respondAck({ error: { code: 'HANDOVER_CODE_EXPIRED', message: 'expired' } });

    const result = await pending;
    if (!result.ok) expect(result.error.message).toBe('Kode handover sudah kedaluwarsa.');
  });

  it('rotates the control token without touching the session credential', async () => {
    const { socket, client } = setup();

    const pending = client.rotateControlToken({ matchId: 'm-1' });
    socket.respondAck({ controlToken: 'new-control', issuedAt: '2026-11-19T10:00:00.000Z' });

    const result = await pending;
    expect(result.ok && result.data.controlToken).toBe('new-control');
    // The ack contains only the control token: nothing about the session.
    expect(JSON.stringify(result)).not.toContain('sessionCredential');
  });

  it('rotates the viewer code', async () => {
    const { socket, client } = setup();

    const pending = client.rotateViewCode({ matchId: 'm-1' });
    socket.respondAck({ viewCode: 'new-view', issuedAt: '2026-11-19T10:00:00.000Z' });

    const result = await pending;
    expect(result.ok && result.data.viewCode).toBe('new-view');
  });

  it('answers a heartbeat', async () => {
    const { socket, client } = setup();

    const pending = client.ping({ ts: 123 });
    socket.respondAck({ ts: 123 });

    await expect(pending).resolves.toMatchObject({ ok: true, data: { ts: 123 } });
  });
});

describe('server event subscriptions', () => {
  it('delivers snapshot, patch, clock, status, operator state, session, and errors', () => {
    const { socket, client } = setup();
    const snapshot = vi.fn();
    const patch = vi.fn();
    const clock = vi.fn();
    const status = vi.fn();
    const operatorState = vi.fn();
    const operatorSession = vi.fn();
    const error = vi.fn();

    client.onSnapshot(snapshot);
    client.onPatch(patch);
    client.onClock(clock);
    client.onStatus(status);
    client.onOperatorState(operatorState);
    client.onOperatorSession(operatorSession);
    client.onMatchError(error);

    socket.serverEmit(SOCKET_EVENTS.snapshot, { matchId: 'm-1', version: 1 });
    socket.serverEmit(SOCKET_EVENTS.patch, { matchId: 'm-1', version: 2 });
    socket.serverEmit(SOCKET_EVENTS.clock, { matchId: 'm-1', clock: { remainingMs: 1 } });
    socket.serverEmit(SOCKET_EVENTS.status, { matchId: 'm-1', matchStatus: 'live' });
    socket.serverEmit(SOCKET_EVENTS.operatorState, { active: true });
    socket.serverEmit(SOCKET_EVENTS.operatorSession, { matchId: 'm-1', sessionId: 's-1' });
    socket.serverEmit(SOCKET_EVENTS.error, { code: 'STATE_CONFLICT', message: 'x' });

    expect(snapshot).toHaveBeenCalledWith({ matchId: 'm-1', version: 1 });
    expect(patch).toHaveBeenCalledWith({ matchId: 'm-1', version: 2 });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(operatorState).toHaveBeenCalledWith({ active: true });
    expect(operatorSession).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes cleanly', () => {
    const { socket, client } = setup();
    const handler = vi.fn();

    const unsubscribe = client.onSnapshot(handler);
    unsubscribe();

    socket.serverEmit(SOCKET_EVENTS.snapshot, { matchId: 'm-1' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('credential hygiene', () => {
  it('never logs credentials while joining or acting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { socket, client } = setup();

    const join = client.join({ matchId: 'm-1', token: 'control-secret' });
    socket.respondAck({ ok: true, role: 'operator' });
    await join;

    const action = client.sendAction({
      matchId: 'm-1',
      type: 'score.change',
      payload: { side: 'home', points: 2 },
      txId: 'tx',
      expectedVersion: 1,
    });
    socket.respondAck({ error: { code: 'STATE_CONFLICT', message: 'conflict' } });
    await action;

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join(' ');

    expect(logged).not.toContain('control-secret');
  });

  it('keeps error messages free of the credential', async () => {
    const { socket, client } = setup();

    const pending = client.join({ matchId: 'm-1', token: 'control-secret' });
    socket.respondAck({ error: { code: 'OPERATOR_SESSION_INVALID', message: 'invalid' } });

    const result = await pending;
    if (!result.ok) {
      expect(result.error.message).not.toContain('control-secret');
      expect(result.error.stack ?? '').not.toContain('control-secret');
    }
  });
});
