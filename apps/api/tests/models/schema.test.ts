import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  AccountModel,
  EventModel,
  EVENT_TYPES,
  MATCH_STATUSES,
  MatchEventModel,
  MatchModel,
  PERIOD_STATUSES,
  RESULT_DECISIONS,
  SPORTS,
  connectDatabase,
  disconnectDatabase,
} from '../../src/models/index.js';
import type { MatchDocument } from '../../src/models/index.js';
import {
  ACTOR_TYPES as SHARED_ACTOR_TYPES,
  BASKETBALL_DEFAULTS,
  EVENT_TYPES as SHARED_EVENT_TYPES,
  MATCH_STATUSES as SHARED_MATCH_STATUSES,
  PERIOD_STATUSES as SHARED_PERIOD_STATUSES,
  RESULT_DECISIONS as SHARED_RESULT_DECISIONS,
  SPORTS as SHARED_SPORTS,
} from '@skoriva/shared';

let mongod: MongoMemoryServer | undefined;

const now = new Date();

function createAccess(viewCodeHash = `view-${new Types.ObjectId().toString()}`) {
  return {
    controlTokenHash: `control-${new Types.ObjectId().toString()}`,
    viewCodeHash,
    viewCodeIssuedAt: now,
    tokenIssuedAt: now,
    revokedTokenHashes: [],
    revokedViewCodeHashes: [],
  };
}

function createMatch(overrides: Record<string, unknown> = {}) {
  return {
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: BASKETBALL_DEFAULTS,
    context: {},
    state: {
      version: 0,
      period: { index: 0, label: 'Q1', status: 'active' },
      clock: {
        mode: 'timed',
        remainingMs: 600_000,
        isRunning: false,
        anchorServerTs: 0,
        lastDurableRemainingMs: 600_000,
        lastDurableAt: now,
        recoveryPending: false,
      },
      sportState: {},
      flags: { clockExpired: false, periodComplete: false },
    },
    access: createAccess(),
    owner: { type: 'device', id: 'device-1' },
    ...overrides,
  };
}

function hasIndex(
  indexes: Array<{ key: Record<string, unknown>; unique?: boolean }>,
  key: Record<string, number>,
  unique = false,
): boolean {
  return indexes.some(
    (index) =>
      JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique === true),
  );
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await connectDatabase(mongod.getUri('skoriva_t07'), { maxAttempts: 2 });

  await Promise.all([
    MatchModel.syncIndexes(),
    MatchEventModel.syncIndexes(),
    EventModel.syncIndexes(),
    AccountModel.syncIndexes(),
  ]);
}, 120_000);

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await disconnectDatabase();
  await mongod?.stop();
});

describe('collection names', () => {
  it('uses the exact Tech Spec collection names', () => {
    expect(MatchModel.collection.collectionName).toBe('matches');
    expect(MatchEventModel.collection.collectionName).toBe('matchEvents');
    expect(EventModel.collection.collectionName).toBe('events');
    expect(AccountModel.collection.collectionName).toBe('accounts');
  });

  it('registers all four collections in MongoDB', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB connection is not ready.');

    const names = (await db.listCollections().toArray()).map((collection) => collection.name);

    expect(names).toEqual(expect.arrayContaining(['matches', 'matchEvents', 'events', 'accounts']));
  });
});

describe('schema shape', () => {
  it('contains the durable clock checkpoint (B-11 / FIX 3)', () => {
    expect(MatchModel.schema.path('state.clock.lastDurableRemainingMs')).toBeDefined();
    expect(MatchModel.schema.path('state.clock.lastDurableAt')).toBeDefined();
    expect(MatchModel.schema.path('state.clock.recoveryPending')).toBeDefined();
  });

  it('contains hash-only access fields (R-01 / R-02 / R-04)', () => {
    expect(MatchModel.schema.path('access.controlTokenHash')).toBeDefined();
    expect(MatchModel.schema.path('access.viewCodeHash')).toBeDefined();
    expect(MatchModel.schema.path('access.viewCode')).toBeUndefined();
    expect(MatchModel.schema.path('access.operatorSession.credentialHash')).toBeDefined();
    expect(MatchModel.schema.path('access.handoverCode.codeHash')).toBeDefined();
    expect(MatchModel.schema.path('access.revokedViewCodeHashes')).toBeDefined();
  });

  it('contains context.eventId and operator grace fields', () => {
    expect(MatchModel.schema.path('context.eventId')).toBeDefined();
    expect(MatchModel.schema.path('operatorGraceUntil')).toBeDefined();
  });

  it('does not define timeout, tournament, or group label', () => {
    const paths = Object.keys(MatchModel.schema.paths).map((path) => path.toLowerCase());

    expect(paths.some((path) => path.includes('timeout'))).toBe(false);
    expect(paths.some((path) => path.includes('tournament'))).toBe(false);
    expect(paths.some((path) => path.includes('grouplabel'))).toBe(false);
  });

  it('requires an account owner on events (B-05)', () => {
    expect(EventModel.schema.path('ownerId')?.isRequired).toBe(true);
    expect(EventModel.schema.path('ownerId')?.options.ref).toBe('Account');
  });

  it('keeps the match event type enum in sync with the domain', () => {
    const typePath = MatchEventModel.schema.path('type') as unknown as {
      enumValues: readonly string[];
    };

    expect(typePath.enumValues).toEqual(SHARED_EVENT_TYPES);
    expect(typePath.enumValues).not.toContain('timeout');
  });
});

describe('enum parity with @skoriva/shared', () => {
  it('keeps all runtime enums aligned', () => {
    expect(SPORTS).toEqual(SHARED_SPORTS);
    expect(MATCH_STATUSES).toEqual(SHARED_MATCH_STATUSES);
    expect(RESULT_DECISIONS).toEqual(SHARED_RESULT_DECISIONS);
    expect(PERIOD_STATUSES).toEqual(SHARED_PERIOD_STATUSES);
    expect(ACTOR_TYPES).toEqual(SHARED_ACTOR_TYPES);
    expect(EVENT_TYPES).toEqual(SHARED_EVENT_TYPES);
  });
});

describe('indexes (Tech Spec §2.5)', () => {
  it('creates the match indexes, including unique viewCodeHash', async () => {
    const indexes = await MatchModel.collection.indexes();

    expect(hasIndex(indexes, { 'context.eventId': 1, matchStatus: 1 })).toBe(true);
    expect(
      hasIndex(indexes, {
        'context.eventId': 1,
        'context.stageLabel': 1,
        'context.matchNumber': 1,
      }),
    ).toBe(true);
    expect(hasIndex(indexes, { resultDecision: 1, finishedAt: -1 })).toBe(true);
    expect(hasIndex(indexes, { 'access.viewCodeHash': 1 }, true)).toBe(true);
    expect(hasIndex(indexes, { 'owner.type': 1, 'owner.id': 1 })).toBe(true);
  });

  it('creates both unique compound indexes on matchEvents', async () => {
    const indexes = await MatchEventModel.collection.indexes();

    expect(hasIndex(indexes, { matchId: 1, seq: 1 }, true)).toBe(true);
    expect(hasIndex(indexes, { matchId: 1, txId: 1 }, true)).toBe(true);
  });

  it('creates the event grouping indexes', async () => {
    const indexes = await EventModel.collection.indexes();

    expect(hasIndex(indexes, { ownerId: 1, archived: 1 })).toBe(true);
    expect(hasIndex(indexes, { parentId: 1, archived: 1 })).toBe(true);
  });

  it('creates the unique account email index', async () => {
    const indexes = await AccountModel.collection.indexes();

    expect(hasIndex(indexes, { email: 1 }, true)).toBe(true);
  });
});

describe('defaults and timestamps', () => {
  it('applies match defaults and Mongoose timestamps', async () => {
    const match = new MatchModel(createMatch() as Partial<MatchDocument>);

    expect(match.matchStatus).toBe('ready');
    expect(match.resultDecision).toBe('undecided');

    await match.save();

    expect(match.createdAt).toBeInstanceOf(Date);
    expect(match.updatedAt).toBeInstanceOf(Date);
    expect(match.toObject()).not.toHaveProperty('__v');
  });

  it('applies the archived default on events', () => {
    const event = new EventModel({
      name: 'Liga Kampus',
      sport: 'futsal',
      ownerId: new Types.ObjectId(),
    });

    expect(event.archived).toBe(false);
  });

  it('adds timestamps to accounts', async () => {
    const account = await AccountModel.create({
      email: 'defaults@example.com',
      passwordHash: 'hash',
    });

    expect(account.createdAt).toBeInstanceOf(Date);
    expect(account.updatedAt).toBeInstanceOf(Date);
    expect(account.toObject()).not.toHaveProperty('__v');
  });

  it('does not add timestamps or __v to append-only matchEvents', async () => {
    const event = await MatchEventModel.create({
      matchId: new Types.ObjectId(),
      seq: 99,
      txId: 'tx-no-timestamps',
      type: 'clock.start',
      payload: {},
      actor: { type: 'system' },
      serverTs: now,
      appliedAt: now,
    });

    const object = event.toObject();

    expect(object).not.toHaveProperty('createdAt');
    expect(object).not.toHaveProperty('updatedAt');
    expect(object).not.toHaveProperty('__v');
  });
});

describe('validation and unique constraints', () => {
  it('rejects a match without access.viewCodeHash', async () => {
    const match = new MatchModel(
      createMatch({
        access: { ...createAccess(), viewCodeHash: undefined },
      }) as Partial<MatchDocument>,
    );

    await expect(match.validate()).rejects.toThrow();
  });

  it('enforces a globally unique access.viewCodeHash', async () => {
    const viewCodeHash = `shared-view-${new Types.ObjectId().toString()}`;

    await MatchModel.create(
      createMatch({ access: createAccess(viewCodeHash) }) as Partial<MatchDocument>,
    );

    await expect(
      MatchModel.create(
        createMatch({ access: createAccess(viewCodeHash) }) as Partial<MatchDocument>,
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('enforces unique { matchId, seq } and { matchId, txId } on matchEvents', async () => {
    const matchId = new Types.ObjectId();
    const baseEvent = {
      matchId,
      seq: 1,
      txId: 'tx-1',
      type: 'score.change',
      payload: { points: 2 },
      actor: { type: 'operator', id: 'op-1' },
      serverTs: now,
      appliedAt: now,
    };

    await MatchEventModel.create(baseEvent);

    await expect(MatchEventModel.create({ ...baseEvent, txId: 'tx-2' })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(MatchEventModel.create({ ...baseEvent, seq: 2 })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('rejects unknown event types such as timeout', async () => {
    const event = new MatchEventModel({
      matchId: new Types.ObjectId(),
      seq: 1,
      txId: 'tx-invalid',
      type: 'timeout',
      payload: {},
      actor: { type: 'system' },
      serverTs: now,
      appliedAt: now,
    });

    await expect(event.validate()).rejects.toThrow();
  });

  it('requires ownerId on events', async () => {
    const event = new EventModel({ name: 'Liga Kampus', sport: 'futsal' });

    await expect(event.validate()).rejects.toThrow();
  });

  it('enforces unique account emails case-insensitively', async () => {
    await AccountModel.create({ email: 'unique@example.com', passwordHash: 'hash' });

    await expect(
      AccountModel.create({ email: 'UNIQUE@example.com', passwordHash: 'hash' }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
