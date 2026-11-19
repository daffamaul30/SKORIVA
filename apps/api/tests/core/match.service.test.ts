import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import { MatchService, MatchServiceError, deriveEventTxId } from '../../src/core/match.service.js';
import type {
  DispatchAction,
  DispatchContext,
  MatchServiceDeps,
} from '../../src/core/match.service.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import { claimOperatorSession } from '../../src/access/operator-session.js';
import { createMatch, findMatchEvents } from '../../src/repositories/match.repo.js';
import type { CreateMatchInput, LoadedMatchWithEvents } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import type { MatchDocument, MatchEventDocument } from '../../src/models/index.js';

const PEPPER = 'test-pepper-0123456789abcdef0123456789';
const T0 = new Date('2026-11-14T10:00:00.000Z');

let mongod: MongoMemoryServer | undefined;

function createState(version = 0): MatchState {
  return {
    version,
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
    matchStatus: 'live',
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

function action(overrides: Partial<DispatchAction> = {}): DispatchAction {
  return {
    type: 'score.change',
    payload: { side: 'home', points: 2 },
    txId: 'tx-1',
    expectedVersion: 0,
    ...overrides,
  } as DispatchAction;
}

const context: DispatchContext = {
  actor: { type: 'operator', id: 'op-1' },
  now: T0,
};

function fakeMatch(overrides: Partial<MatchDocument> = {}): MatchDocument {
  return {
    _id: new Types.ObjectId(),
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
    access: {
      controlTokenHash: 'control',
      viewCodeHash: 'view',
      viewCodeIssuedAt: T0,
      tokenIssuedAt: T0,
      revokedTokenHashes: [],
      revokedViewCodeHashes: [],
    },
    owner: { type: 'device', id: 'device-1' },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function fakeEvent(seq: number, txId: string): MatchEventDocument {
  return {
    _id: new Types.ObjectId(),
    matchId: new Types.ObjectId(),
    seq,
    txId,
    type: 'score.change',
    payload: { side: 'home', points: 2 },
    actor: { type: 'operator', id: 'op-1' },
    serverTs: T0,
    appliedAt: T0,
  };
}

function loaded(match: MatchDocument, events: MatchEventDocument[] = []): LoadedMatchWithEvents {
  const lastSeq = events[events.length - 1]?.seq ?? 0;
  const lastStateAffecting = [...events].reverse().find((event) => event.type !== 'match.create');
  const lastStateAffectingSeq = lastStateAffecting?.seq ?? 0;

  return {
    match,
    events,
    lastSeq,
    lastStateAffectingSeq,
    maxSeq: lastSeq,
    needsReplay: match.state.version < lastStateAffectingSeq,
  };
}

function createUnitService(overrides: Partial<MatchServiceDeps> = {}) {
  const match = fakeMatch();
  const deps: Partial<MatchServiceDeps> = {
    authorize: vi.fn(async () => undefined),
    loadMatch: vi.fn(async () => loaded(match)),
    persist: vi.fn(async ({ events }: { events: { seq: number; txId: string }[] }) => ({
      status: 'committed' as const,
      events: events.map((event) => fakeEvent(event.seq, event.txId)),
    })),
    queue: new MatchQueue(),
    ...overrides,
  };

  return { service: new MatchService(deps), match, deps };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t12_pipeline'));
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

describe('txId derivation', () => {
  it('keeps the action txId for the first event and appends seq afterwards', () => {
    expect(deriveEventTxId('tx-1', 5, 0)).toBe('tx-1');
    expect(deriveEventTxId('tx-1', 6, 1)).toBe('tx-1:6');
    expect(deriveEventTxId('tx-1', 7, 2)).toBe('tx-1:7');
  });
});

describe('MatchService.dispatch unit', () => {
  it('returns an ack only after a successful persist', async () => {
    const { service, deps } = createUnitService();

    const result = await service.dispatch('match-1', action(), context);

    expect(result).toMatchObject({ status: 'committed', version: 1, txId: 'tx-1' });
    expect(deps.persist).toHaveBeenCalledOnce();
  });

  it('returns the current snapshot for a duplicate txId without persisting again', async () => {
    const match = fakeMatch({ state: createState(1) });
    const events = [fakeEvent(1, 'tx-1')];
    const persist = vi.fn();
    const { service } = createUnitService({
      loadMatch: vi.fn(async () => loaded(match, events)),
      persist,
    });

    const result = await service.dispatch('match-1', action({ expectedVersion: 1 }), context);

    expect(result).toMatchObject({ status: 'duplicate', version: 1, txId: 'tx-1' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects a stale expectedVersion with the current snapshot', async () => {
    const match = fakeMatch({ state: createState(3) });
    const { service } = createUnitService({
      loadMatch: vi.fn(async () => loaded(match)),
    });

    const result = await service.dispatch('match-1', action({ expectedVersion: 2 }), context);

    expect(result).toMatchObject({ status: 'version_conflict', version: 3 });
    if (result.status === 'version_conflict') {
      expect(result.snapshot.version).toBe(3);
    }
  });

  it('checks idempotency before the version guard', async () => {
    const match = fakeMatch({ state: createState(5) });
    const events = [fakeEvent(5, 'tx-1')];
    const { service } = createUnitService({
      loadMatch: vi.fn(async () => loaded(match, events)),
    });

    const result = await service.dispatch('match-1', action({ expectedVersion: 0 }), context);

    expect(result.status).toBe('duplicate');
  });

  it('rejects an unsupported action type', async () => {
    const { service } = createUnitService();

    await expect(
      service.dispatch('match-1', action({ type: 'timeout' as never }), context),
    ).rejects.toBeInstanceOf(MatchServiceError);
  });

  it('rejects a txId that is too long', async () => {
    const { service } = createUnitService();

    await expect(
      service.dispatch('match-1', action({ txId: 'x'.repeat(129) }), context),
    ).rejects.toMatchObject({ code: 'TX_ID_TOO_LONG' });
  });

  it('reloads and replays after a state conflict without retrying the action', async () => {
    const match = fakeMatch({ state: createState(0) });
    const persist = vi.fn(async ({ events }: { events: { seq: number; txId: string }[] }) => ({
      status: 'state_conflict' as const,
      events: events.map((event) => fakeEvent(event.seq, event.txId)),
    }));
    const replay = vi.fn((base: MatchState, events: readonly MatchEventDocument[]) => ({
      ...base,
      version: events[events.length - 1]?.seq ?? base.version,
    }));
    const replayMatch = vi.fn(async () => ({
      status: 'replayed' as const,
      match,
      events: [fakeEvent(1, 'tx-1')],
      maxSeq: 1,
    }));
    const loadMatch = vi
      .fn()
      .mockResolvedValueOnce(loaded(match))
      .mockResolvedValueOnce(loaded(match, [fakeEvent(1, 'tx-1')]))
      .mockResolvedValueOnce(loaded({ ...match, state: createState(1) }, [fakeEvent(1, 'tx-1')]));

    const { service } = createUnitService({ loadMatch, persist, replay, replayMatch });

    const result = await service.dispatch('match-1', action(), context);

    expect(result.status).toBe('state_conflict');
    expect(persist).toHaveBeenCalledOnce();
    expect(replayMatch).toHaveBeenCalledOnce();
    if (result.status === 'state_conflict') {
      expect(result.snapshot.version).toBe(1);
    }
  });
});

describe('MatchService.dispatch integration', () => {
  async function createLiveMatch(): Promise<{ matchId: string; credential: string }> {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const session = await claimOperatorSession(matchId, PEPPER, T0);
    return { matchId, credential: session.credential };
  }

  it('persists an action and returns the committed version', async () => {
    const { matchId, credential } = await createLiveMatch();
    const service = new MatchService();

    const result = await service.dispatch(matchId, action(), {
      ...context,
      operatorCredential: credential,
    });

    expect(result).toMatchObject({ status: 'committed', version: 1, txId: 'tx-1' });

    const events = await findMatchEvents(matchId);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.txId).toBe('tx-1');
  });

  it('does not apply a duplicate txId twice', async () => {
    const { matchId, credential } = await createLiveMatch();
    const service = new MatchService();

    await service.dispatch(matchId, action(), { ...context, operatorCredential: credential });
    const duplicate = await service.dispatch(matchId, action({ expectedVersion: 1 }), {
      ...context,
      operatorCredential: credential,
    });

    expect(duplicate.status).toBe('duplicate');
    expect(await findMatchEvents(matchId)).toHaveLength(1);
  });

  it('serializes concurrent actions for the same match', async () => {
    const { matchId, credential } = await createLiveMatch();
    const service = new MatchService();

    const [first, second] = await Promise.all([
      service.dispatch(matchId, action({ txId: 'tx-a' }), {
        ...context,
        operatorCredential: credential,
      }),
      service.dispatch(matchId, action({ txId: 'tx-b' }), {
        ...context,
        operatorCredential: credential,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['committed', 'version_conflict']);
    expect(await findMatchEvents(matchId)).toHaveLength(1);
  });

  it('rejects an action without an operator credential', async () => {
    const { matchId } = await createLiveMatch();
    const service = new MatchService();

    await expect(service.dispatch(matchId, action(), context)).rejects.toMatchObject({
      code: 'OPERATOR_REQUIRED',
    });
  });
});
