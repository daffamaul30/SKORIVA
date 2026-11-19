import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import {
  SnapshotError,
  composeFolders,
  createReplayFn,
  createSportEngineFolder,
  eventToAction,
  foldEvents,
  isSnapshotInSync,
  pendingEvents,
  replayMatchSnapshot,
} from '../../src/core/snapshot.js';
import type { EventFolder, SportReducerLike } from '../../src/core/snapshot.js';
import {
  createMatch,
  loadMatchWithEvents,
  persistEventsAndState,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput, NewMatchEvent } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import type { MatchEventDocument } from '../../src/models/index.js';

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

function event(seq: number, type: MatchEventDocument['type'] = 'score.change'): MatchEventDocument {
  return {
    _id: new Types.ObjectId(),
    matchId: new Types.ObjectId(),
    seq,
    txId: `tx-${seq}`,
    type,
    payload: { side: 'home', points: 2 },
    actor: { type: 'operator', id: 'op-1' },
    serverTs: T0,
    appliedAt: T0,
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

const countingFolder: EventFolder = (state, current) => ({
  ...state,
  sportState: {
    ...state.sportState,
    count: Number(state.sportState.count ?? 0) + 1,
    lastType: current.type,
  },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t15_snapshot'));
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

describe('foldEvents', () => {
  it('folds pending events in sequence order and sets version to the last seq', () => {
    const state = foldEvents(createState(0), [event(1), event(2), event(3)], countingFolder);

    expect(state.version).toBe(3);
    expect(state.sportState.count).toBe(3);
    expect(state.sportState.lastType).toBe('score.change');
  });

  it('ignores events already covered by the snapshot', () => {
    const state = foldEvents(createState(2), [event(1), event(2), event(3)], countingFolder);

    expect(state.version).toBe(3);
    expect(state.sportState.count).toBe(1);
  });

  it('is deterministic across repeated folds', () => {
    const events = [event(1), event(2), event(3)];
    const first = foldEvents(createState(0), events, countingFolder);
    const second = foldEvents(createState(0), events, countingFolder);

    expect(second).toEqual(first);
  });

  it('fails loudly on a sequence gap', () => {
    expect(() => foldEvents(createState(0), [event(1), event(3)], countingFolder)).toThrow(
      expect.objectContaining({ code: 'SEQUENCE_GAP' }),
    );
  });

  it('reports pending events and sync state', () => {
    const events = [event(1), event(2)];
    expect(pendingEvents(createState(1), events).map((item) => item.seq)).toEqual([2]);
    expect(isSnapshotInSync(createState(2), 2)).toBe(true);
    expect(isSnapshotInSync(createState(1), 2)).toBe(false);
  });

  it('composes folders in order', () => {
    const first: EventFolder = (state) => ({
      ...state,
      sportState: { ...state.sportState, order: ['first'] },
    });
    const second: EventFolder = (state) => ({
      ...state,
      sportState: {
        ...state.sportState,
        order: [...(state.sportState.order as string[]), 'second'],
      },
    });

    const state = foldEvents(createState(0), [event(1)], composeFolders(first, second));
    expect(state.sportState.order).toEqual(['first', 'second']);
  });
});

describe('sport engine adapter', () => {
  const engine = {
    reduce: (state: Record<string, unknown>, action: { type: string; payload: unknown }) => {
      if (action.type !== 'score.change') {
        return { ok: false as const, code: 'UNSUPPORTED', message: 'unsupported' };
      }
      const payload = action.payload as { points: number };
      return {
        ok: true as const,
        state: { ...state, score: Number(state.score ?? 0) + payload.points },
        emitted: ['score.change' as const],
      };
    },
  } as unknown as SportReducerLike;

  it('reduces operational events into sportState', () => {
    const folder = createSportEngineFolder(engine);
    const state = foldEvents(createState(0), [event(1), event(2)], folder);

    expect(state.sportState.score).toBe(4);
    expect(state.version).toBe(2);
  });

  it('ignores non-operational events', () => {
    const folder = createSportEngineFolder(engine);
    const state = foldEvents(createState(0), [event(1, 'match.start')], folder);

    expect(state.sportState.score).toBeUndefined();
    expect(state.version).toBe(1);
  });

  it('converts operational events to actions', () => {
    expect(eventToAction(event(1))).toEqual({
      type: 'score.change',
      payload: { side: 'home', points: 2 },
    });
    expect(eventToAction(event(1, 'match.start'))).toBeNull();
  });
});

describe('replay integration', () => {
  it('fold(log) equals the materialized snapshot', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const events = [newEvent(1), newEvent(2), newEvent(3)];

    const materialized = foldEvents(createState(0), events, countingFolder);
    const persisted = await persistEventsAndState({
      matchId,
      events,
      state: materialized,
    });
    expect(persisted.status).toBe('committed');

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(loaded!.match.state, loaded!.events, countingFolder);

    expect(folded).toEqual(loaded!.match.state);
    expect(loaded!.needsReplay).toBe(false);
  });

  it('repairs a half-successful write by replaying durable events', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    // Events are durable but the state update is stale (version 0).
    const conflicted = await persistEventsAndState({
      matchId,
      events: [newEvent(1), newEvent(2)],
      state: createState(0),
    });
    expect(conflicted.status).toBe('state_conflict');

    const before = await loadMatchWithEvents(matchId);
    expect(before?.needsReplay).toBe(true);

    const replayed = await replayMatchSnapshot(matchId, countingFolder);
    expect(replayed.status).toBe('replayed');

    const after = await loadMatchWithEvents(matchId);
    expect(after?.match.state.version).toBe(2);
    expect(after?.match.state.sportState.count).toBe(2);
    expect(after?.needsReplay).toBe(false);
  });

  it('leaves an in-sync match untouched', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    await persistEventsAndState({
      matchId,
      events: [newEvent(1)],
      state: foldEvents(createState(0), [newEvent(1)], countingFolder),
    });

    const result = await replayMatchSnapshot(matchId, countingFolder);
    expect(result.status).toBe('in_sync');
  });

  it('exposes a repository-compatible replay function', () => {
    const replay = createReplayFn(countingFolder);
    const state = replay(createState(0), [event(1), event(2)]);

    expect(state.version).toBe(2);
    expect(state.sportState.count).toBe(2);
  });

  it('throws a typed error when a logged event cannot be reduced', () => {
    const failingEngine = {
      reduce: () => ({ ok: false as const, code: 'NOPE', message: 'nope' }),
    } as unknown as SportReducerLike;

    expect(() =>
      foldEvents(createState(0), [event(1)], createSportEngineFolder(failingEngine)),
    ).toThrow(SnapshotError);
  });
});
