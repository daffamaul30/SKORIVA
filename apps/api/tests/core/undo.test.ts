import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState, SportState } from '@skoriva/shared';
import {
  UndoError,
  correctResult,
  foldWithUndo,
  resolveActionTxId,
  restoreResult,
  undoAction,
} from '../../src/core/undo.js';
import { MatchService } from '../../src/core/match.service.js';
import type { DispatchAction } from '../../src/core/match.service.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import { lifecycleGuard } from '../../src/core/lifecycle.js';
import { eventLogBuilder } from '../../src/core/event-log.js';
import { createReplayFn } from '../../src/core/snapshot.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReducer } from '../../src/sports/shared/reducer.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';
import type { SportEngineRuntime } from '../../src/sports/shared/types.js';
import {
  createMatch,
  findMatchById,
  findMatchEvents,
  loadMatchWithEvents,
  persistEventsAndState,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let mongod: MongoMemoryServer | undefined;

function createState(sportState: SportState = {}): MatchState {
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
    sportState,
    flags: { clockExpired: false, periodComplete: false },
  };
}

function createMatchInput(overrides: Partial<CreateMatchInput> = {}): CreateMatchInput {
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
    ...overrides,
  };
}

function fakeEngine(initialScore = 0): SportEngineRuntime {
  return {
    sport: 'basketball',
    defaults: () => BASKETBALL_DEFAULTS,
    init: () => ({ score: initialScore, count: 0 }),
    validateConfig: () => ({ ok: true }),
    validate: () => ({ ok: true }),
    reduce: (state, action) => {
      if (action.type === 'score.change') {
        const payload = action.payload as { points: number };
        return {
          ok: true,
          state: {
            ...state,
            score: Number(state.score ?? 0) + payload.points,
            count: Number(state.count ?? 0) + 1,
          },
          emitted: ['score.change', 'period.next'],
        };
      }
      return { ok: true, state, emitted: [action.type] };
    },
    deriveDisplay: (state) => ({
      score: { home: Number(state.score ?? 0), away: 0 },
    }),
    suggestions: () => [],
    canStepBackPeriod: () => true,
    correct: (state, correction) => {
      const value = correction as { homeScore: number; awayScore: number };
      return {
        ok: true,
        sportState: { ...state.sportState, score: value.homeScore },
        before: { score: { home: Number(state.sportState.score ?? 0), away: 0 } },
        after: { score: { home: value.homeScore, away: value.awayScore } },
      };
    },
  };
}

function action(
  type: DispatchAction['type'],
  overrides: Partial<DispatchAction> = {},
): DispatchAction {
  return {
    type,
    payload: {},
    txId: `tx-${type}`,
    expectedVersion: 0,
    ...overrides,
  } as DispatchAction;
}

function createService(
  registry: SportRegistry,
  folder: ReturnType<typeof createSportReplayFolder>,
) {
  return new MatchService({
    authorize: async () => undefined,
    lifecycle: lifecycleGuard,
    reduce: createSportReducer(registry),
    buildEvents: eventLogBuilder,
    replay: createReplayFn(folder),
    loadMatch: loadMatchWithEvents,
    persist: ({ matchId, events, state }) => persistEventsAndState({ matchId, events, state }),
    queue: new MatchQueue(),
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t18_undo'));
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

describe('action identity', () => {
  it('resolves the action txId for first and derived events', () => {
    const events = [
      { seq: 1, txId: 'tx-a' },
      { seq: 2, txId: 'tx-a:2' },
      { seq: 3, txId: 'tx-b' },
    ];

    expect(resolveActionTxId(events[0]!, events)).toBe('tx-a');
    expect(resolveActionTxId(events[1]!, events)).toBe('tx-a');
    expect(resolveActionTxId(events[2]!, events)).toBe('tx-b');
  });

  it('keeps action ids that contain a colon intact', () => {
    const events = [
      { seq: 1, txId: 'tx:1' },
      { seq: 2, txId: 'tx:1:2' },
    ];

    expect(resolveActionTxId(events[0]!, events)).toBe('tx:1');
    expect(resolveActionTxId(events[1]!, events)).toBe('tx:1');
  });
});

describe('undoAction', () => {
  it('undoes one complete multi-event action and reverts the period marker', async () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const service = createService(registry, folder);
    const match = await createMatch(
      createMatchInput({ state: createState({ score: 0, count: 0 }) }),
    );
    const matchId = match._id.toString();

    const dispatched = await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 2 } }),
      { actor: { type: 'operator', id: 'op-1' }, now: T0 },
    );
    expect(dispatched.status).toBe('committed');

    const events = await findMatchEvents(matchId);
    expect(events.map((event) => event.type)).toEqual(['score.change', 'period.next']);

    const result = await undoAction({
      matchId,
      targetSeq: events[0]!.seq,
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: at(1),
    });

    expect(result.actionTxId).toBe('tx-score.change');
    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.match.state.sportState).toMatchObject({ score: 0, count: 0 });
    expect(loaded?.match.state.period.index).toBe(0);
    expect(loaded?.events.map((event) => event.type)).toContain('match.undo');
  });

  it('rejects undo of a non-last action', async () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const service = createService(registry, folder);
    const match = await createMatch(
      createMatchInput({ state: createState({ score: 0, count: 0 }) }),
    );
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { txId: 'tx-a', payload: { side: 'home', points: 2 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );
    await service.dispatch(
      matchId,
      action('score.change', {
        txId: 'tx-b',
        expectedVersion: 2,
        payload: { side: 'home', points: 2 },
      }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: at(1),
      },
    );

    const events = await findMatchEvents(matchId);
    await expect(
      undoAction({
        matchId,
        targetSeq: events[0]!.seq,
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: at(2),
      }),
    ).rejects.toMatchObject({ code: 'UNDO_NOT_LAST' });
  });

  it('rejects undo of an undo event', async () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const service = createService(registry, folder);
    const match = await createMatch(
      createMatchInput({ state: createState({ score: 0, count: 0 }) }),
    );
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 2 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );
    const events = await findMatchEvents(matchId);
    await undoAction({
      matchId,
      targetSeq: events[0]!.seq,
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: at(1),
    });

    const afterUndo = await findMatchEvents(matchId);
    const undoEvent = afterUndo.find((event) => event.type === 'match.undo')!;

    await expect(
      undoAction({
        matchId,
        targetSeq: undoEvent.seq,
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: at(2),
      }),
    ).rejects.toMatchObject({ code: 'UNDO_TARGET_INVALID' });
  });

  it('rejects undo on a saved result', async () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(
      createMatchInput({
        matchStatus: 'finished',
        resultDecision: 'saved',
        state: createState({ score: 0, count: 0 }),
      }),
    );

    await expect(
      undoAction({
        matchId: match._id.toString(),
        targetSeq: 1,
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: 'UNDO_REQUIRES_CORRECTION' });
  });

  it('rejects an undo that would produce a negative score', async () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine(-1));
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const service = createService(registry, folder);
    const match = await createMatch(
      createMatchInput({ state: createState({ score: -1, count: 0 }) }),
    );
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 1 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );
    const events = await findMatchEvents(matchId);

    await expect(
      undoAction({
        matchId,
        targetSeq: events[0]!.seq,
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: at(1),
      }),
    ).rejects.toMatchObject({ code: 'UNDO_NEGATIVE_SCORE' });
  });
});

describe('correctResult', () => {
  it('corrects a saved basketball result without changing lifecycle status', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(
      createMatchInput({
        matchStatus: 'finished',
        resultDecision: 'saved',
        state: createState(basketballEngine.init(BASKETBALL_DEFAULTS)),
      }),
    );
    const matchId = match._id.toString();

    const result = await correctResult({
      matchId,
      correction: { homeScore: 99, awayScore: 98 },
      reason: 'Salah input skor akhir',
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: T0,
    });

    expect(result.after.score).toEqual({ home: 99, away: 98 });

    const loaded = await findMatchById(matchId);
    expect(loaded?.matchStatus).toBe('finished');
    expect(loaded?.resultDecision).toBe('saved');
    expect(loaded?.state.sportState).toMatchObject({ score: { home: 99, away: 98 } });

    const events = await findMatchEvents(matchId);
    expect(events.map((event) => event.type)).toEqual(['result.correct']);
    expect(events[0]?.payload).toMatchObject({
      reason: 'Salah input skor akhir',
      before: { score: { home: 0, away: 0 } },
      after: { score: { home: 99, away: 98 } },
    });
  });

  it('uses the provided txId for correction idempotency', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(
      createMatchInput({
        matchStatus: 'finished',
        resultDecision: 'saved',
        state: createState(basketballEngine.init(BASKETBALL_DEFAULTS)),
      }),
    );
    const matchId = match._id.toString();

    await correctResult({
      matchId,
      correction: { homeScore: 10, awayScore: 9 },
      reason: 'Koreksi',
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: T0,
      txId: 'tx-correct-1',
    });

    const events = await findMatchEvents(matchId);
    expect(events[0]?.txId).toBe('tx-correct-1');
  });

  it('rejects correction on a non-saved match', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(createMatchInput());

    await expect(
      correctResult({
        matchId: match._id.toString(),
        correction: { homeScore: 1, awayScore: 0 },
        reason: 'x',
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: 'CORRECTION_NOT_ALLOWED' });
  });

  it('fails hard when replay produces a different after value', () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const state = createState(basketballEngine.init(BASKETBALL_DEFAULTS));

    expect(() =>
      folder(state, {
        seq: 1,
        type: 'result.correct',
        payload: {
          correction: { homeScore: 10, awayScore: 5 },
          after: { score: { home: 999, away: 5 } },
        },
        serverTs: T0,
      }),
    ).toThrow(expect.objectContaining({ code: 'CORRECTION_REPLAY_MISMATCH' }));
  });
});

describe('restoreResult', () => {
  it('restores a discarded result to undecided without changing match status', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(
      createMatchInput({
        matchStatus: 'finished',
        resultDecision: 'discarded',
        state: createState(basketballEngine.init(BASKETBALL_DEFAULTS)),
      }),
    );
    const matchId = match._id.toString();

    const result = await restoreResult({
      matchId,
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: T0,
    });

    expect(result.version).toBe(1);
    const loaded = await findMatchById(matchId);
    expect(loaded?.matchStatus).toBe('finished');
    expect(loaded?.resultDecision).toBe('undecided');
    expect((await findMatchEvents(matchId)).map((event) => event.type)).toEqual(['result.restore']);
  });

  it('uses the provided txId for restore idempotency', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(
      createMatchInput({
        matchStatus: 'finished',
        resultDecision: 'discarded',
        state: createState(basketballEngine.init(BASKETBALL_DEFAULTS)),
      }),
    );
    const matchId = match._id.toString();

    await restoreResult({
      matchId,
      actor: { type: 'operator', id: 'op-1' },
      registry,
      folder,
      now: T0,
      txId: 'tx-restore-1',
    });

    const events = await findMatchEvents(matchId);
    expect(events[0]?.txId).toBe('tx-restore-1');
  });

  it('rejects restore on a non-discarded match', async () => {
    const registry = new SportRegistry();
    registry.register(basketballEngine);
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const match = await createMatch(createMatchInput());

    await expect(
      restoreResult({
        matchId: match._id.toString(),
        actor: { type: 'operator', id: 'op-1' },
        registry,
        folder,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(UndoError);
  });
});

describe('foldWithUndo', () => {
  it('skips the target action and the undo marker', () => {
    const registry = new SportRegistry();
    registry.register(fakeEngine());
    const folder = createSportReplayFolder({
      registry,
      config: BASKETBALL_DEFAULTS,
      sport: 'basketball',
    });
    const events = [
      {
        seq: 1,
        txId: 'tx-a',
        type: 'score.change' as const,
        payload: { side: 'home', points: 2 },
        serverTs: T0,
      },
      {
        seq: 2,
        txId: 'tx-a:2',
        type: 'period.next' as const,
        payload: {},
        serverTs: T0,
      },
      {
        seq: 3,
        txId: 'undo-1',
        type: 'match.undo' as const,
        payload: { targetSeq: 1 },
        serverTs: T0,
      },
    ];

    const folded = foldWithUndo(createState({ score: 0, count: 0 }), events, folder);
    expect(folded.sportState).toMatchObject({ score: 0, count: 0 });
    expect(folded.period.index).toBe(0);
  });
});
