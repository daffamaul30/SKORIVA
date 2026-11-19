import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import {
  DEFAULT_RUNTIME_IDLE_TTL_MS,
  MatchRuntimeRegistry,
  RuntimeRegistryError,
} from '../../src/core/runtime.registry.js';
import type { EventFolder } from '../../src/core/snapshot.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import {
  createMatch,
  findMatchById,
  persistEventsAndState,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput, NewMatchEvent } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';

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

function newEvent(seq: number): NewMatchEvent {
  return {
    seq,
    txId: `tx-${seq}`,
    type: 'score.change',
    payload: { side: 'home', points: 2 },
    actor: { type: 'operator', id: 'op-1' },
    serverTs: T0,
    appliedAt: T0,
  };
}

const countingFolder: EventFolder = (state) => ({
  ...state,
  sportState: { ...state.sportState, count: Number(state.sportState.count ?? 0) + 1 },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t17_registry'));
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

describe('hydration', () => {
  it('hydrates a cold match and caches the runtime', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    const loaded = await registry.loadMatch(matchId);

    expect(loaded?.match.state.version).toBe(0);
    expect(registry.has(matchId)).toBe(true);
    expect(registry.peek(matchId)?.matchId).toBe(matchId);
    expect(registry.size).toBe(1);
  });

  it('returns null for an unknown match', async () => {
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    expect(await registry.loadMatch(new Types.ObjectId().toString())).toBeNull();
  });

  it('replays a stale snapshot during hydration', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    await persistEventsAndState({
      matchId,
      events: [newEvent(1), newEvent(2)],
      state: createState(0),
    });

    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });
    const loaded = await registry.loadMatch(matchId);

    expect(loaded?.match.state.version).toBe(2);
    expect(loaded?.match.state.sportState.count).toBe(2);
    expect(loaded?.needsReplay).toBe(false);
  });

  it('requires a replay folder when the snapshot is stale', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    await persistEventsAndState({
      matchId,
      events: [newEvent(1)],
      state: createState(0),
    });

    const registry = new MatchRuntimeRegistry({ now: () => T0 });

    await expect(registry.loadMatch(matchId)).rejects.toMatchObject({
      code: 'REPLAY_REQUIRED',
    });
  });
});

describe('serial execution', () => {
  it('runs tasks for the same match one at a time', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const registry = new MatchRuntimeRegistry({
      replay: countingFolder,
      queue: new MatchQueue(),
      now: () => T0,
    });

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = registry.runExclusive(matchId, async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });

    const second = registry.runExclusive(matchId, async () => {
      order.push('second-start');
      order.push('second-end');
    });

    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('hydrates before running a cold task', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    const seen = await registry.runExclusive(matchId, async (runtime) => runtime.state.version);

    expect(seen).toBe(0);
    expect(registry.has(matchId)).toBe(true);
  });

  it('rejects a task for an unknown match', async () => {
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    await expect(
      registry.runExclusive(new Types.ObjectId().toString(), async () => undefined),
    ).rejects.toBeInstanceOf(RuntimeRegistryError);
  });
});

describe('eviction', () => {
  it('evicts a runtime without deleting database data', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    await registry.loadMatch(matchId);
    expect(registry.evict(matchId)).toBe(true);
    expect(registry.has(matchId)).toBe(false);
    expect(await findMatchById(matchId)).not.toBeNull();
  });

  it('evicts only idle runtimes', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const registry = new MatchRuntimeRegistry({ replay: countingFolder, now: () => T0 });

    await registry.loadMatch(matchId);

    expect(registry.evictIdle(new Date(T0.getTime() + DEFAULT_RUNTIME_IDLE_TTL_MS - 1))).toBe(0);
    expect(registry.evictIdle(new Date(T0.getTime() + DEFAULT_RUNTIME_IDLE_TTL_MS + 1))).toBe(1);
    expect(await findMatchById(matchId)).not.toBeNull();
  });
});
