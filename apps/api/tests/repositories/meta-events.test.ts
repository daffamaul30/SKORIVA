import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import {
  appendEvents,
  createMatch,
  findMatchEvents,
  loadMatchWithEvents,
  persistEventsAndState,
  replayMatchState,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput, NewMatchEvent } from '../../src/repositories/match.repo.js';
import { MatchService } from '../../src/core/match.service.js';
import type { StateReducer } from '../../src/core/match.service.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import { eventLogBuilder } from '../../src/core/event-log.js';
import { createReplayFn, foldEvents } from '../../src/core/snapshot.js';
import type { EventFolder } from '../../src/core/snapshot.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

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

function createEvent(seq: number, txId: string): NewMatchEvent {
  return {
    seq,
    txId,
    type: 'match.create',
    payload: { sport: 'basketball' },
    actor: { type: 'system' },
    serverTs: T0,
    appliedAt: T0,
  };
}

const folder: EventFolder = (state, event) => {
  if (event.type !== 'score.change') return state;
  const payload = event.payload as { points: number };
  return {
    ...state,
    sportState: {
      ...state.sportState,
      score: Number(state.sportState.score ?? 0) + payload.points,
    },
  };
};

const reducer: StateReducer = (state, action) => {
  if (action.type === 'score.change') {
    const payload = action.payload as { points: number };
    const sportState = state.sportState ?? {};
    return {
      state: {
        ...state,
        sportState: {
          ...sportState,
          score: Number(sportState.score ?? 0) + payload.points,
        },
      },
      emitted: ['score.change'],
    };
  }
  return { state, emitted: [action.type] };
};

function createService(): MatchService {
  return new MatchService({
    authorize: async () => undefined,
    reduce: reducer,
    buildEvents: eventLogBuilder,
    replay: createReplayFn(folder),
    loadMatch: loadMatchWithEvents,
    persist: ({ matchId, events, state }) => persistEventsAndState({ matchId, events, state }),
    queue: new MatchQueue(),
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_meta_events'));
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

describe('match.create meta event', () => {
  it('A. keeps the snapshot at v0 and does not request replay', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    await appendEvents(matchId, [createEvent(1, 'create-1')]);

    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.lastSeq).toBe(1);
    expect(loaded?.lastStateAffectingSeq).toBe(0);
    expect(loaded?.maxSeq).toBe(1);
    expect(loaded?.match.state.version).toBe(0);
    expect(loaded?.needsReplay).toBe(false);

    const folded = foldEvents(loaded!.match.state, loaded!.events, folder);
    expect(folded.version).toBe(0);

    const replayed = await replayMatchState(matchId, createReplayFn(folder));
    expect(replayed.status).toBe('in_sync');
  });

  it('B. allocates the first score at seq 2 and sets state.version 2', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    await appendEvents(matchId, [createEvent(1, 'create-1')]);

    const service = createService();
    const result = await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'tx-score-1',
        expectedVersion: 0,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );

    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.version).toBe(2);
    }

    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(loaded?.lastSeq).toBe(2);
    expect(loaded?.lastStateAffectingSeq).toBe(2);
    expect(loaded?.match.state.version).toBe(2);
    expect(loaded?.needsReplay).toBe(false);
  });

  it('C. replays match.create + score to the same materialized state', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    await appendEvents(matchId, [createEvent(1, 'create-1')]);

    const service = createService();
    await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 3 },
        txId: 'tx-score-1',
        expectedVersion: 0,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(createState(), loaded!.events, folder);

    expect(folded).toEqual(loaded!.match.state);
    expect(folded.version).toBe(2);
  });

  it('D. handles multiple meta events without a version mismatch', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();

    await appendEvents(matchId, [createEvent(1, 'create-1'), createEvent(2, 'create-2')]);

    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.lastSeq).toBe(2);
    expect(loaded?.lastStateAffectingSeq).toBe(0);
    expect(loaded?.match.state.version).toBe(0);
    expect(loaded?.needsReplay).toBe(false);
    expect(foldEvents(loaded!.match.state, loaded!.events, folder).version).toBe(0);

    const service = createService();
    await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'tx-score-1',
        expectedVersion: 0,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(3) },
    );

    const after = await loadMatchWithEvents(matchId);
    expect(after?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(after?.lastStateAffectingSeq).toBe(3);
    expect(after?.match.state.version).toBe(3);
    expect(after?.needsReplay).toBe(false);
  });

  it('E. keeps event sequences monotonic', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    await appendEvents(matchId, [createEvent(1, 'create-1')]);

    const service = createService();
    await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'tx-score-1',
        expectedVersion: 0,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );
    await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'away', points: 3 },
        txId: 'tx-score-2',
        expectedVersion: 2,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(2) },
    );

    const events = await findMatchEvents(matchId);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.seq)).toEqual(
      [...events.map((event) => event.seq)].sort((left, right) => left - right),
    );
  });

  it('F. keeps idempotency across meta and state events', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    await appendEvents(matchId, [createEvent(1, 'create-1')]);

    const service = createService();
    const first = await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'tx-score-1',
        expectedVersion: 0,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );
    expect(first.status).toBe('committed');

    const duplicate = await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'tx-score-1',
        expectedVersion: 2,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(2) },
    );
    expect(duplicate.status).toBe('duplicate');

    const metaDuplicate = await service.dispatch(
      matchId,
      {
        type: 'score.change',
        payload: { side: 'home', points: 2 },
        txId: 'create-1',
        expectedVersion: 2,
      },
      { actor: { type: 'operator', id: 'op-1' }, now: at(3) },
    );
    expect(metaDuplicate.status).toBe('duplicate');

    expect(await findMatchEvents(matchId)).toHaveLength(2);
  });
});
