import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import {
  EventSequenceConflictError,
  appendEvents,
  countMatchesForEvent,
  createMatch,
  findMatchById,
  findMatchEvents,
  loadMatchWithEvents,
  persistEventsAndState,
  replayMatchState,
  updateMatchStateConditional,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput, NewMatchEvent } from '../../src/repositories/match.repo.js';
import type { MatchState } from '@skoriva/shared';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';

let mongod: MongoMemoryServer | undefined;
const now = new Date();

function createState(version: number): MatchState {
  return {
    version,
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
  };
}

function createMatchInput(overrides: Partial<CreateMatchInput> = {}): CreateMatchInput {
  const suffix = new Types.ObjectId().toString();

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
    state: createState(0),
    access: {
      controlTokenHash: `control-${suffix}`,
      viewCodeHash: `view-${suffix}`,
      viewCodeIssuedAt: now,
      tokenIssuedAt: now,
      revokedTokenHashes: [],
      revokedViewCodeHashes: [],
    },
    owner: { type: 'device', id: 'device-1' },
    ...overrides,
  };
}

function createEvent(seq: number, txId: string): NewMatchEvent {
  return {
    seq,
    txId,
    type: 'score.change',
    payload: { side: 'home', points: 2 },
    actor: { type: 'operator', id: 'op-1' },
    serverTs: now,
    appliedAt: now,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t08_match'));
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

describe('createMatch / findMatchById', () => {
  it('creates a match and reads it back', async () => {
    const created = await createMatch(createMatchInput());

    expect(created._id).toBeInstanceOf(Types.ObjectId);
    expect(created.matchStatus).toBe('ready');
    expect(created.resultDecision).toBe('undecided');
    expect(created.state.version).toBe(0);
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await findMatchById(created._id.toString());
    expect(found?.teams.home.name).toBe('Garuda');
    expect(found?.state.version).toBe(0);
  });

  it('returns null for an unknown match', async () => {
    expect(await findMatchById(new Types.ObjectId().toString())).toBeNull();
  });
});

describe('persistEventsAndState', () => {
  it('writes events first and then conditionally commits state', async () => {
    const match = await createMatch(createMatchInput());

    const result = await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1'), createEvent(2, 'tx-2')],
      state: createState(2),
    });

    expect(result.status).toBe('committed');
    expect(result.events).toHaveLength(2);

    const loaded = await loadMatchWithEvents(match._id.toString());
    expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(loaded?.match.state.version).toBe(2);
    expect(loaded?.maxSeq).toBe(2);
    expect(loaded?.needsReplay).toBe(false);
  });

  it('treats a duplicate txId as idempotent and does not write again', async () => {
    const match = await createMatch(createMatchInput());

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1'), createEvent(2, 'tx-2')],
      state: createState(2),
    });

    const duplicate = await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1'), createEvent(2, 'tx-2')],
      state: createState(3),
    });

    expect(duplicate.status).toBe('duplicate_tx');
    expect(duplicate.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(await findMatchEvents(match._id.toString())).toHaveLength(2);

    const loaded = await loadMatchWithEvents(match._id.toString());
    expect(loaded?.match.state.version).toBe(2);
  });

  it('throws EventSequenceConflictError for a duplicate seq', async () => {
    const match = await createMatch(createMatchInput());

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1')],
      state: createState(1),
    });

    await expect(
      persistEventsAndState({
        matchId: match._id.toString(),
        events: [createEvent(1, 'tx-2')],
        state: createState(2),
      }),
    ).rejects.toBeInstanceOf(EventSequenceConflictError);
  });

  it('returns state_conflict but keeps events when the state version is stale', async () => {
    const match = await createMatch(createMatchInput());

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1'), createEvent(2, 'tx-2')],
      state: createState(2),
    });

    const stale = await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(3, 'tx-3')],
      state: createState(2),
    });

    expect(stale.status).toBe('state_conflict');
    expect(stale.events.map((event) => event.seq)).toEqual([3]);

    const loaded = await loadMatchWithEvents(match._id.toString());
    expect(loaded?.match.state.version).toBe(2);
    expect(loaded?.maxSeq).toBe(3);
    expect(loaded?.needsReplay).toBe(true);
  });

  it('keeps events when the conditional state update throws', async () => {
    const match = await createMatch(createMatchInput());
    const updateSpy = vi
      .spyOn(MatchModel, 'updateOne')
      .mockRejectedValueOnce(new Error('state write failed'));

    try {
      const result = await persistEventsAndState({
        matchId: match._id.toString(),
        events: [createEvent(1, 'tx-1'), createEvent(2, 'tx-2')],
        state: createState(2),
      });

      expect(result.status).toBe('state_update_failed');
      expect(result.events).toHaveLength(2);
    } finally {
      updateSpy.mockRestore();
    }

    const loaded = await loadMatchWithEvents(match._id.toString());
    expect(loaded?.match.state.version).toBe(0);
    expect(loaded?.maxSeq).toBe(2);
    expect(loaded?.needsReplay).toBe(true);
  });

  it('returns match_not_found without writing events', async () => {
    const result = await persistEventsAndState({
      matchId: new Types.ObjectId().toString(),
      events: [createEvent(1, 'tx-1')],
      state: createState(1),
    });

    expect(result.status).toBe('match_not_found');
    expect(await MatchEventModel.countDocuments({})).toBe(0);
  });
});

describe('conditional state update', () => {
  it('applies only a newer state version and rejects stale updates', async () => {
    const match = await createMatch(createMatchInput());

    await updateMatchStateConditional(match._id.toString(), createState(2));

    const stale = await updateMatchStateConditional(match._id.toString(), createState(1));
    expect(stale.applied).toBe(false);

    const newer = await updateMatchStateConditional(match._id.toString(), createState(3), {
      matchStatus: 'live',
      startedAt: new Date(),
    });
    expect(newer.applied).toBe(true);

    const loaded = await findMatchById(match._id.toString());
    expect(loaded?.state.version).toBe(3);
    expect(loaded?.matchStatus).toBe('live');
    expect(loaded?.startedAt).toBeInstanceOf(Date);
  });

  it('does not allow matchPatch to overwrite state', async () => {
    const match = await createMatch(createMatchInput());

    await updateMatchStateConditional(match._id.toString(), createState(1), {
      matchStatus: 'live',
      state: createState(99),
    } as never);

    const loaded = await findMatchById(match._id.toString());
    expect(loaded?.state.version).toBe(1);
    expect(loaded?.matchStatus).toBe('live');
  });
});

describe('replayMatchState', () => {
  it('leaves an in-sync match untouched', async () => {
    const match = await createMatch(createMatchInput());

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1')],
      state: createState(1),
    });

    const replay = vi.fn((base: MatchState) => base);
    const result = await replayMatchState(match._id.toString(), replay);

    expect(result.status).toBe('in_sync');
    expect(replay).not.toHaveBeenCalled();
  });

  it('replays and persists state via the injected reducer', async () => {
    const match = await createMatch(createMatchInput());

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(1, 'tx-1')],
      state: createState(1),
    });

    await persistEventsAndState({
      matchId: match._id.toString(),
      events: [createEvent(2, 'tx-2')],
      state: createState(1),
    });

    const replay = vi.fn((base: MatchState, events: readonly { seq: number }[]) => ({
      ...base,
      version: events[events.length - 1]?.seq ?? base.version,
    }));

    const result = await replayMatchState(match._id.toString(), replay);

    expect(result.status).toBe('replayed');
    expect(replay).toHaveBeenCalledOnce();

    const loaded = await loadMatchWithEvents(match._id.toString());
    expect(loaded?.match.state.version).toBe(2);
    expect(loaded?.needsReplay).toBe(false);
  });

  it('returns match_not_found for an unknown match', async () => {
    const result = await replayMatchState(new Types.ObjectId().toString(), (base) => base);

    expect(result.status).toBe('match_not_found');
  });
});

describe('appendEvents validation', () => {
  it('rejects an empty event list', async () => {
    const match = await createMatch(createMatchInput());

    await expect(appendEvents(match._id.toString(), [])).rejects.toThrow(
      'At least one event is required.',
    );
  });

  it('rejects duplicate txIds within one append', async () => {
    const match = await createMatch(createMatchInput());

    await expect(
      appendEvents(match._id.toString(), [createEvent(1, 'tx-1'), createEvent(2, 'tx-1')]),
    ).rejects.toThrow('Each event in one append must have a unique txId.');
  });
});

describe('event grouping counts', () => {
  it('counts matches attached to an event', async () => {
    const eventId = new Types.ObjectId();
    await createMatch(createMatchInput({ context: { eventId } }));
    await createMatch(createMatchInput());

    expect(await countMatchesForEvent(eventId.toString())).toBe(1);
  });
});
