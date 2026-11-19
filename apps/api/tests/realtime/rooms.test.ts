import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import { createMatchCredentials } from '../../src/access/tokens.js';
import { createMatch, loadMatchWithEvents } from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import { RoomManager } from '../../src/realtime/rooms.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';

const PEPPER = 'test-pepper-0123456789abcdef0123456789';
const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let mongod: MongoMemoryServer | undefined;

class FakeGateway implements RealtimeGateway {
  joins: Array<{ matchId: string; clientRef: string; role: string }> = [];
  leaves: Array<{ matchId: string; clientRef: string }> = [];
  patches: Array<{ matchId: string; payload: unknown; roleFilter: string }> = [];
  clocks: Array<{ matchId: string; payload: unknown }> = [];
  statuses: Array<{ matchId: string; payload: unknown }> = [];
  operatorStates: Array<{ matchId: string; payload: unknown }> = [];
  emits: Array<{ clientRef: string; event: string; payload: unknown }> = [];
  disconnected: Array<{ matchId: string; role: string }> = [];

  join(matchId: string, clientRef: string, role: 'operator' | 'viewer'): void {
    this.joins.push({ matchId, clientRef, role });
  }
  leave(matchId: string, clientRef: string): void {
    this.leaves.push({ matchId, clientRef });
  }
  disconnectRole(matchId: string, role: 'operator' | 'viewer'): void {
    this.disconnected.push({ matchId, role });
  }
  broadcastPatch(matchId: string, payload: unknown, roleFilter: string): void {
    this.patches.push({ matchId, payload, roleFilter });
  }
  broadcastClock(matchId: string, payload: unknown): void {
    this.clocks.push({ matchId, payload });
  }
  broadcastStatus(matchId: string, payload: unknown): void {
    this.statuses.push({ matchId, payload });
  }
  broadcastOperatorState(matchId: string, payload: unknown): void {
    this.operatorStates.push({ matchId, payload });
  }
  emitTo(clientRef: string, event: string, payload: unknown): void {
    this.emits.push({ clientRef, event, payload });
  }
}

function createState(): MatchState {
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
    sportState: {},
    flags: { clockExpired: false, periodComplete: false },
  };
}

function createMatchInput(access: CreateMatchInput['access']): CreateMatchInput {
  return {
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: BASKETBALL_DEFAULTS,
    context: {},
    matchStatus: 'ready',
    resultDecision: 'undecided',
    state: createState(),
    access,
    owner: { type: 'device', id: 'device-1' },
  };
}

async function setup() {
  const credentials = createMatchCredentials(PEPPER, T0);
  const match = await createMatch(createMatchInput(credentials.access));
  const gateway = new FakeGateway();
  let now = T0;
  const rooms = new RoomManager({
    gateway,
    pepper: PEPPER,
    loadMatch: loadMatchWithEvents,
    now: () => now,
    graceSweepIntervalMs: 5_000,
  });

  return {
    credentials,
    matchId: match._id.toString(),
    gateway,
    rooms,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t25_rooms'));
  await Promise.all([MatchModel.syncIndexes(), MatchEventModel.syncIndexes()]);
});

beforeEach(async () => {
  await Promise.all([MatchEventModel.deleteMany({}), MatchModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('RoomManager operator access', () => {
  it('claims an operator session with the control token and issues a private credential', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();

    const result = await rooms.joinOperator('s1', matchId, credentials.controlToken);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('operator');
      expect(result.sessionIssue?.credential).toBeTruthy();
    }
    expect(gateway.joins).toEqual([{ matchId, clientRef: 's1', role: 'operator' }]);
    expect(gateway.operatorStates[0]?.payload).toMatchObject({ active: true });
  });

  it('reconnects with the session credential without creating a new session', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    const first = await rooms.joinOperator('s1', matchId, credentials.controlToken);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.sessionIssue) throw new Error('expected session');

    const before = await MatchModel.findById(matchId).lean().exec();
    const second = await rooms.joinOperator('s2', matchId, first.sessionIssue.credential);
    const after = await MatchModel.findById(matchId).lean().exec();

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.sessionIssue).toBeUndefined();
    expect(after?.access.operatorSession?.sessionId).toBe(
      before?.access.operatorSession?.sessionId,
    );
    expect(gateway.joins).toHaveLength(2);
  });

  it('rejects a stale session credential without falling back to the control token', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    const first = await rooms.joinOperator('s1', matchId, credentials.controlToken);
    if (!first.ok || !first.sessionIssue) throw new Error('expected session');

    await MatchModel.updateOne(
      { _id: matchId },
      { $set: { activeOperatorId: 'another-session' } },
    ).exec();

    const result = await rooms.joinOperator('s2', matchId, first.sessionIssue.credential);

    expect(result).toMatchObject({ ok: false, code: 'OPERATOR_SESSION_STALE' });
    expect(gateway.joins).toHaveLength(1);
  });

  it('rejects a second operator with the control token', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    await rooms.joinOperator('s1', matchId, credentials.controlToken);

    const result = await rooms.joinOperator('s2', matchId, credentials.controlToken);

    expect(result).toMatchObject({ ok: false, code: 'OPERATOR_SESSION_CONFLICT' });
    expect(gateway.emits).toContainEqual({
      clientRef: 's2',
      event: 'operator:state',
      payload: { active: false },
    });
  });

  it('rejects a revoked session credential', async () => {
    const { credentials, matchId, rooms } = await setup();
    const first = await rooms.joinOperator('s1', matchId, credentials.controlToken);
    if (!first.ok || !first.sessionIssue) throw new Error('expected session');

    await MatchModel.updateOne(
      { _id: matchId },
      { $set: { 'access.operatorSession.revokedAt': T0 } },
    ).exec();

    const result = await rooms.joinOperator('s2', matchId, first.sessionIssue.credential);
    expect(result).toMatchObject({ ok: false, code: 'OPERATOR_SESSION_REVOKED' });
  });
});

describe('RoomManager viewer access', () => {
  it('joins a viewer with a valid view code and rejects an invalid one', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();

    const valid = await rooms.joinViewer('v1', matchId, credentials.viewCode);
    const invalid = await rooms.joinViewer('v2', matchId, 'wrong');

    expect(valid.ok).toBe(true);
    expect(invalid).toMatchObject({ ok: false, code: 'VIEW_CODE_INVALID' });
    expect(gateway.joins).toEqual([{ matchId, clientRef: 'v1', role: 'viewer' }]);
  });
});

describe('RoomManager grace and cleanup', () => {
  it('sets the 30 second grace on leave and broadcasts it', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    await rooms.joinOperator('s1', matchId, credentials.controlToken);

    await rooms.leave('s1', matchId);

    const match = await MatchModel.findById(matchId).lean().exec();
    expect(match?.operatorGraceUntil).toEqual(at(30));
    expect(gateway.operatorStates.at(-1)?.payload).toMatchObject({
      active: true,
      graceUntil: at(30).toISOString(),
    });
  });

  it('sweeps expired grace and broadcasts inactive state', async () => {
    const { credentials, matchId, gateway, rooms, setNow } = await setup();
    await rooms.joinOperator('s1', matchId, credentials.controlToken);
    await rooms.leave('s1', matchId);

    setNow(at(31));
    const swept = await rooms.sweepGrace();

    expect(swept).toBe(1);
    expect(gateway.operatorStates.at(-1)?.payload).toEqual({ active: false });
    const match = await MatchModel.findById(matchId).lean().exec();
    expect(match?.activeOperatorId).toBeUndefined();
  });

  it('evicts viewers and disconnects the viewer role room', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    await rooms.joinViewer('v1', matchId, credentials.viewCode);

    rooms.evictViewers(matchId);

    expect(gateway.disconnected).toEqual([{ matchId, role: 'viewer' }]);
    expect(rooms.getContext('v1')).toBeUndefined();
  });

  it('evicts prior operator sockets on handover', async () => {
    const { credentials, matchId, gateway, rooms } = await setup();
    await rooms.joinOperator('s1', matchId, credentials.controlToken);

    rooms.adoptOperator('s2', matchId, {
      sessionId: 'new-session',
      credential: 'new-credential',
      expiresAt: T0,
    });
    rooms.evictOperators(matchId, 'new-session');

    expect(rooms.getContext('s1')).toBeUndefined();
    expect(gateway.emits).toContainEqual({
      clientRef: 's1',
      event: 'operator:state',
      payload: { active: false },
    });
  });
});
