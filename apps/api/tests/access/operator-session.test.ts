import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import {
  HANDOVER_CODE_TTL_MS,
  OPERATOR_GRACE_MS,
  OPERATOR_SESSION_HEADER,
  OperatorSessionError,
  acceptHandoverCode,
  claimOperatorSession,
  createHandoverCode,
  getOperatorState,
  isOperatorActive,
  markOperatorDisconnected,
  reconnectOperatorSession,
  rotateOperatorControlToken,
  sweepExpiredOperatorSessions,
  verifyOperatorSession,
} from '../../src/access/operator-session.js';
import { createMatch, findMatchById, findMatchEvents } from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';

const PEPPER = 'test-pepper-0123456789abcdef0123456789';
const T0 = new Date('2026-11-14T10:00:00.000Z');

let mongod: MongoMemoryServer | undefined;

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

function createMatchInput(): CreateMatchInput {
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
    access: {
      controlTokenHash: `control-${new Types.ObjectId().toString()}`,
      viewCodeHash: `view-${new Types.ObjectId().toString()}`,
      viewCodeIssuedAt: T0,
      tokenIssuedAt: T0,
      revokedTokenHashes: [],
      revokedViewCodeHashes: [],
    },
    owner: { type: 'device', id: 'device-1' },
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t11_operator'));
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

async function createTestMatch(): Promise<string> {
  const match = await createMatch(createMatchInput());
  return match._id.toString();
}

describe('claimOperatorSession', () => {
  it('issues a session and marks the operator active', async () => {
    const matchId = await createTestMatch();

    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    const match = await findMatchById(matchId);

    expect(issued.credential).toHaveLength(43);
    expect(match?.activeOperatorId).toBe(issued.sessionId);
    expect(match?.access.operatorSession?.sessionId).toBe(issued.sessionId);
    expect(match?.access.operatorSession?.credentialHash).not.toBe(issued.credential);
    expect(isOperatorActive(match!, T0)).toBe(true);
  });

  it('rejects a second claim while the first operator is active', async () => {
    const matchId = await createTestMatch();
    await claimOperatorSession(matchId, PEPPER, T0);

    await expect(claimOperatorSession(matchId, PEPPER, T0)).rejects.toMatchObject({
      code: 'OPERATOR_SESSION_CONFLICT',
    });
  });
});

describe('disconnect and reconnect', () => {
  it('retains the lock for the grace window and reconnects with the same credential', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);

    const graceUntil = await markOperatorDisconnected(matchId, issued.credential, PEPPER, T0);
    expect(graceUntil.getTime()).toBe(T0.getTime() + OPERATOR_GRACE_MS);

    const reconnected = await reconnectOperatorSession(
      matchId,
      issued.credential,
      PEPPER,
      new Date(T0.getTime() + 10_000),
    );

    expect(reconnected.session.sessionId).toBe(issued.sessionId);
    const match = await findMatchById(matchId);
    expect(match?.operatorGraceUntil).toBeUndefined();
    expect(isOperatorActive(match!, new Date(T0.getTime() + 10_000))).toBe(true);
  });

  it('releases the lock after the grace window and rejects the old credential', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    await markOperatorDisconnected(matchId, issued.credential, PEPPER, T0);

    const afterGrace = new Date(T0.getTime() + OPERATOR_GRACE_MS + 1);

    await expect(
      reconnectOperatorSession(matchId, issued.credential, PEPPER, afterGrace),
    ).rejects.toMatchObject({ code: 'OPERATOR_SESSION_EXPIRED' });

    const next = await claimOperatorSession(matchId, PEPPER, afterGrace);
    expect(next.sessionId).not.toBe(issued.sessionId);

    const match = await findMatchById(matchId);
    expect(match?.activeOperatorId).toBe(next.sessionId);
  });
});

describe('handover', () => {
  it('creates a one-time code bound to the source session and transfers control', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);

    const handover = await createHandoverCode(matchId, issued.credential, PEPPER, T0);
    expect(handover.expiresAt.getTime()).toBe(T0.getTime() + HANDOVER_CODE_TTL_MS);

    const stored = await findMatchById(matchId);
    expect(stored?.access.handoverCode?.codeHash).not.toBe(handover.code);
    expect(stored?.access.handoverCode?.sourceSessionId).toBe(issued.sessionId);

    const accepted = await acceptHandoverCode(matchId, handover.code, PEPPER, T0);
    expect(accepted.sessionId).not.toBe(issued.sessionId);
    expect(accepted.sourceSessionId).toBe(issued.sessionId);

    await expect(
      verifyOperatorSession(matchId, issued.credential, PEPPER, T0),
    ).rejects.toMatchObject({ code: 'OPERATOR_SESSION_INVALID' });

    await expect(
      verifyOperatorSession(matchId, accepted.credential, PEPPER, T0),
    ).resolves.toBeDefined();
  });

  it('rejects reusing a consumed code', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    const handover = await createHandoverCode(matchId, issued.credential, PEPPER, T0);
    await acceptHandoverCode(matchId, handover.code, PEPPER, T0);

    await expect(acceptHandoverCode(matchId, handover.code, PEPPER, T0)).rejects.toMatchObject({
      code: 'HANDOVER_CODE_INVALID',
    });
  });

  it('rejects an expired code', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    const handover = await createHandoverCode(matchId, issued.credential, PEPPER, T0);

    await expect(
      acceptHandoverCode(
        matchId,
        handover.code,
        PEPPER,
        new Date(T0.getTime() + HANDOVER_CODE_TTL_MS + 1),
      ),
    ).rejects.toMatchObject({ code: 'HANDOVER_CODE_EXPIRED' });
  });

  it('rejects a handover code from another match', async () => {
    const matchA = await createTestMatch();
    const matchB = await createTestMatch();
    const sessionA = await claimOperatorSession(matchA, PEPPER, T0);
    await claimOperatorSession(matchB, PEPPER, T0);
    const handover = await createHandoverCode(matchA, sessionA.credential, PEPPER, T0);

    await expect(acceptHandoverCode(matchB, handover.code, PEPPER, T0)).rejects.toMatchObject({
      code: 'HANDOVER_CODE_INVALID',
    });
  });

  it('records an operator.handover event', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    const handover = await createHandoverCode(matchId, issued.credential, PEPPER, T0);
    await acceptHandoverCode(matchId, handover.code, PEPPER, T0);

    const events = await findMatchEvents(matchId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('operator.handover');
    expect(events[0]?.seq).toBe(1);
  });
});

describe('token rotation interaction', () => {
  it('rotates only the control token and leaves the operator session intact', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    const before = await findMatchById(matchId);

    const rotated = await rotateOperatorControlToken(matchId, PEPPER, T0);
    const after = await findMatchById(matchId);

    expect(rotated.controlToken).toBeTruthy();
    expect(after?.access.controlTokenHash).not.toBe(before?.access.controlTokenHash);
    expect(after?.activeOperatorId).toBe(issued.sessionId);
    expect(after?.access.operatorSession).toEqual(before?.access.operatorSession);

    await expect(
      verifyOperatorSession(matchId, issued.credential, PEPPER, T0),
    ).resolves.toBeDefined();

    const events = await findMatchEvents(matchId);
    expect(events.map((event) => event.type)).toContain('operator.tokenRotate');
  });
});

describe('verification and cleanup', () => {
  it('exposes the REST lifecycle header name', () => {
    expect(OPERATOR_SESSION_HEADER).toBe('x-operator-session');
  });

  it('reports operator:state for the active and inactive clients', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);

    await expect(getOperatorState(matchId, issued.credential, PEPPER, T0)).resolves.toEqual({
      active: true,
      sessionId: issued.sessionId,
    });
    await expect(getOperatorState(matchId, 'other', PEPPER, T0)).resolves.toEqual({
      active: false,
    });
  });

  it('reports a stale session when it is no longer the active session', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);

    await MatchModel.updateOne(
      { _id: matchId },
      { $set: { activeOperatorId: 'another-session' } },
    ).exec();

    await expect(
      verifyOperatorSession(matchId, issued.credential, PEPPER, T0),
    ).rejects.toMatchObject({ code: 'OPERATOR_SESSION_STALE' });
  });

  it('rejects an unknown credential', async () => {
    const matchId = await createTestMatch();
    await claimOperatorSession(matchId, PEPPER, T0);

    await expect(verifyOperatorSession(matchId, 'unknown', PEPPER, T0)).rejects.toBeInstanceOf(
      OperatorSessionError,
    );
  });

  it('sweeps expired grace windows without deleting match data', async () => {
    const matchId = await createTestMatch();
    const issued = await claimOperatorSession(matchId, PEPPER, T0);
    await markOperatorDisconnected(matchId, issued.credential, PEPPER, T0);

    const swept = await sweepExpiredOperatorSessions(
      new Date(T0.getTime() + OPERATOR_GRACE_MS + 1),
    );

    expect(swept).toBe(1);
    const match = await findMatchById(matchId);
    expect(match).not.toBeNull();
    expect(match?.activeOperatorId).toBeFalsy();
    expect(match?.access.operatorSession?.revokedAt).toBeInstanceOf(Date);
  });
});
