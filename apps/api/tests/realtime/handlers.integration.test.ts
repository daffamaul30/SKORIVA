import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { createMatchCredentials } from '../../src/access/tokens.js';
import { resolveOperatorAccess } from '../../src/access/guard.js';
import { createMatch, findMatchEvents } from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import { createSocketServer } from '../../src/realtime/socket.js';
import { setupRealtime } from '../../src/realtime/index.js';
import type { RealtimeRuntime } from '../../src/realtime/index.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let mongod: MongoMemoryServer | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let realtime: RealtimeRuntime | undefined;
let port = 0;
let now = T0;
const clients: ClientSocket[] = [];

function createState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 0,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 600_000,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: 600_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: basketballEngine.init(BASKETBALL_DEFAULTS),
    flags: { clockExpired: false, periodComplete: false },
    ...overrides,
  };
}

function createMatchInput(
  access: CreateMatchInput['access'],
  overrides: Partial<CreateMatchInput> = {},
): CreateMatchInput {
  return {
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: BASKETBALL_DEFAULTS,
    context: {},
    matchStatus: 'live',
    resultDecision: 'undecided',
    state: createState(),
    access,
    owner: { type: 'device', id: 'device-1' },
    ...overrides,
  };
}

async function createTestMatch(overrides: Partial<CreateMatchInput> = {}) {
  const credentials = createMatchCredentials(env.TOKEN_PEPPER, T0);
  const match = await createMatch(createMatchInput(credentials.access, overrides));
  return { credentials, matchId: match._id.toString() };
}

function connect(): ClientSocket {
  const client = createClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  clients.push(client);
  return client;
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

function waitFor<T>(socket: ClientSocket, event: string): Promise<T> {
  return withTimeout(
    new Promise((resolve) => {
      socket.once(event, (payload: T) => resolve(payload));
    }),
    `event ${event}`,
  );
}

function waitForState(socket: ClientSocket, active: boolean): Promise<Record<string, unknown>> {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (payload: Record<string, unknown>) => {
        if (payload.active === active) {
          socket.off('operator:state', handler);
          resolve(payload);
        }
      };
      socket.on('operator:state', handler);
    }),
    `operator:state active=${active}`,
  );
}

function emitAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return withTimeout(
    new Promise((resolve) => {
      socket.emit(event, payload, (response: T) => resolve(response));
    }),
    `ack ${event}`,
  );
}

async function joinOperator(socket: ClientSocket, matchId: string, token: string) {
  const snapshot = waitFor<Record<string, unknown>>(socket, 'match:snapshot');
  const session = waitFor<Record<string, unknown>>(socket, 'operator:session');
  const ack = await emitAck<Record<string, unknown>>(socket, 'match:join', { matchId, token });
  return { ack, snapshot: await snapshot, session: await session };
}

async function reconnectOperator(socket: ClientSocket, matchId: string, token: string) {
  const snapshot = waitFor<Record<string, unknown>>(socket, 'match:snapshot');
  const ack = await emitAck<Record<string, unknown>>(socket, 'match:join', { matchId, token });
  return { ack, snapshot: await snapshot };
}

async function joinViewer(socket: ClientSocket, matchId: string, viewCode: string) {
  const snapshot = waitFor<Record<string, unknown>>(socket, 'match:snapshot');
  const ack = await emitAck<Record<string, unknown>>(socket, 'match:join', { matchId, viewCode });
  return { ack, snapshot: await snapshot };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t28_socket'));
  await Promise.all([MatchModel.syncIndexes(), MatchEventModel.syncIndexes()]);

  const app = createApp();
  httpServer = createServer(app);
  const io = createSocketServer(httpServer, { webOrigin: env.WEB_ORIGIN });
  realtime = setupRealtime(io, {
    pepper: env.TOKEN_PEPPER,
    graceSweepIntervalMs: 60_000,
    tickIntervalMs: 60_000,
    now: () => now,
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, '127.0.0.1', () => resolve());
  });
  port = (httpServer.address() as AddressInfo).port;
});

beforeEach(async () => {
  now = T0;
  await Promise.all([MatchEventModel.deleteMany({}), MatchModel.deleteMany({})]);
});

afterAll(async () => {
  for (const client of clients) client.disconnect();
  realtime?.stop();
  await new Promise<void>((resolve) => {
    httpServer?.close(() => resolve());
  });
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('Socket.IO operator and viewer flows', () => {
  it('issues a private session, dispatches an action, and broadcasts role-scoped patches', async () => {
    const { credentials, matchId } = await createTestMatch();
    const operator = connect();
    const viewer = connect();

    const joined = await joinOperator(operator, matchId, credentials.controlToken);
    expect(joined.ack).toMatchObject({ ok: true, role: 'operator' });
    expect(joined.session.credential).toBeTruthy();
    expect(joined.snapshot).toMatchObject({ version: 0 });

    const viewerJoined = await joinViewer(viewer, matchId, credentials.viewCode);
    expect(viewerJoined.snapshot).not.toHaveProperty('state');

    const operatorPatch = waitFor<Record<string, unknown>>(operator, 'match:patch');
    const viewerPatch = waitFor<Record<string, unknown>>(viewer, 'match:patch');
    const ack = await emitAck<Record<string, unknown>>(operator, 'match:action', {
      matchId,
      txId: 'tx-score-1',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });

    expect(ack).toMatchObject({ version: 1, txId: 'tx-score-1' });
    expect((await operatorPatch).state).toBeDefined();
    expect(await viewerPatch).not.toHaveProperty('state');
  });

  it('rejects viewer actions and lifecycle actions over the socket', async () => {
    const { credentials, matchId } = await createTestMatch();
    const operator = connect();
    const viewer = connect();
    await joinOperator(operator, matchId, credentials.controlToken);
    await joinViewer(viewer, matchId, credentials.viewCode);

    const viewerError = waitFor<Record<string, unknown>>(viewer, 'match:error');
    await emitAck(viewer, 'match:action', {
      matchId,
      txId: 'tx-viewer',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    expect(await viewerError).toMatchObject({ code: 'FORBIDDEN' });

    const lifecycleError = waitFor<Record<string, unknown>>(operator, 'match:error');
    await emitAck(operator, 'match:action', {
      matchId,
      txId: 'tx-lifecycle',
      expectedVersion: 0,
      type: 'match.start',
      payload: {},
    });
    expect(await lifecycleError).toMatchObject({ code: 'LIFECYCLE_VIA_REST' });
  });

  it('is idempotent for duplicate txId and returns a snapshot on stale version', async () => {
    const { credentials, matchId } = await createTestMatch();
    const operator = connect();
    await joinOperator(operator, matchId, credentials.controlToken);

    const first = await emitAck<Record<string, unknown>>(operator, 'match:action', {
      matchId,
      txId: 'tx-score-1',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    expect(first.version).toBe(1);

    const duplicate = await emitAck<Record<string, unknown>>(operator, 'match:action', {
      matchId,
      txId: 'tx-score-1',
      expectedVersion: 1,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    expect(duplicate).toMatchObject({ version: 1, txId: 'tx-score-1' });
    expect(await findMatchEvents(matchId)).toHaveLength(1);

    const staleError = waitFor<Record<string, unknown>>(operator, 'match:error');
    await emitAck(operator, 'match:action', {
      matchId,
      txId: 'tx-score-2',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    const error = await staleError;
    expect(error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 1 });
    expect(error.snapshot).toBeDefined();
  });

  it('handover moves control, demotes the old operator, and rotates view code/token', async () => {
    const { credentials, matchId } = await createTestMatch();
    const oldOperator = connect();
    const target = connect();
    const viewer = connect();

    await joinOperator(oldOperator, matchId, credentials.controlToken);
    await joinViewer(target, matchId, credentials.viewCode);
    await joinViewer(viewer, matchId, credentials.viewCode);

    const handover = await emitAck<Record<string, unknown>>(
      oldOperator,
      'operator:handover.create',
      {
        matchId,
      },
    );
    expect(handover.code).toBeTruthy();

    const demoted = waitForState(oldOperator, false);
    const targetSession = waitFor<Record<string, unknown>>(target, 'operator:session');
    const accepted = await emitAck<Record<string, unknown>>(target, 'operator:handover.accept', {
      matchId,
      code: handover.code,
    });
    expect(accepted).toMatchObject({ active: true });
    expect((await targetSession).credential).toBeTruthy();
    await demoted;

    const forbidden = waitFor<Record<string, unknown>>(oldOperator, 'match:error');
    await emitAck(oldOperator, 'match:action', {
      matchId,
      txId: 'tx-old',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    expect(await forbidden).toMatchObject({ code: 'FORBIDDEN' });

    const viewerDisconnected = new Promise<void>((resolve) => {
      viewer.once('disconnect', () => resolve());
    });
    const rotatedView = await emitAck<Record<string, unknown>>(
      target,
      'operator:rotate-view-code',
      {
        matchId,
      },
    );
    expect(rotatedView.viewCode).toBeTruthy();
    await viewerDisconnected;

    const rotatedToken = await emitAck<Record<string, unknown>>(target, 'operator:rotate-token', {
      matchId,
    });
    expect(rotatedToken.controlToken).toBeTruthy();
    expect(
      await resolveOperatorAccess(matchId, credentials.controlToken, env.TOKEN_PEPPER),
    ).toBeNull();
    expect(
      await resolveOperatorAccess(matchId, String(rotatedToken.controlToken), env.TOKEN_PEPPER),
    ).not.toBeNull();
  });

  it('confirms clock recovery through the shared pipeline', async () => {
    const { credentials, matchId } = await createTestMatch({
      state: createState({
        clock: {
          mode: 'timed',
          remainingMs: 300_000,
          isRunning: false,
          anchorServerTs: 0,
          lastDurableRemainingMs: 300_000,
          lastDurableAt: T0,
          recoveryPending: true,
        },
      }),
    });
    const operator = connect();
    await joinOperator(operator, matchId, credentials.controlToken);

    const ack = await emitAck<Record<string, unknown>>(operator, 'clock.confirm', {
      matchId,
      txId: 'tx-confirm',
      expectedVersion: 0,
      payload: { remainingMs: 300_000 },
    });

    expect(ack).toMatchObject({ version: 1, txId: 'tx-confirm' });
    const match = await MatchModel.findById(matchId).lean().exec();
    expect(match?.state.clock.recoveryPending).toBe(false);
  });

  it('isolates match rooms', async () => {
    const first = await createTestMatch();
    const second = await createTestMatch();
    const viewerA = connect();
    const operatorB = connect();
    await joinViewer(viewerA, first.matchId, first.credentials.viewCode);
    await joinOperator(operatorB, second.matchId, second.credentials.controlToken);

    let received = false;
    viewerA.on('match:patch', () => {
      received = true;
    });

    await emitAck(operatorB, 'match:action', {
      matchId: second.matchId,
      txId: 'tx-isolation',
      expectedVersion: 0,
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toBe(false);
  });

  it('answers match:pong', async () => {
    const client = connect();
    const response = waitFor<Record<string, unknown>>(client, 'match:pong');

    await emitAck(client, 'match:pong', { ts: 123 });

    expect(await response).toEqual({ ts: 123 });
  });

  it('reconnects within grace and rejects after grace', async () => {
    const { credentials, matchId } = await createTestMatch();
    const operator = connect();
    const observer = connect();
    const joined = await joinOperator(operator, matchId, credentials.controlToken);
    await joinViewer(observer, matchId, credentials.viewCode);
    const credential = String(joined.session.credential);

    const graceState = waitForState(observer, true);
    operator.disconnect();
    await graceState;

    now = at(10);
    const reconnected = connect();
    const reconnectJoin = await reconnectOperator(reconnected, matchId, credential);
    expect(reconnectJoin.ack).toMatchObject({ ok: true, role: 'operator' });

    const graceAgain = waitForState(observer, true);
    reconnected.disconnect();
    await graceAgain;

    now = at(41);
    const late = connect();
    const lateError = waitFor<Record<string, unknown>>(late, 'match:error');
    await emitAck(late, 'match:join', { matchId, token: credential });
    expect(await lateError).toMatchObject({ code: 'OPERATOR_SESSION_EXPIRED' });
  });
});
