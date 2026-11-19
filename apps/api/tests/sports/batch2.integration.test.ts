import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MatchConfig, MatchState, Sport } from '@skoriva/shared';
import {
  BADMINTON_DEFAULTS,
  BASKETBALL_DEFAULTS,
  FUTSAL_DEFAULTS,
  VOLLEYBALL_DEFAULTS,
} from '../../src/sports/shared/constants.js';
import { builtInSportRegistry, registerBuiltInEngines } from '../../src/sports/builtins.js';
import { SportRegistry } from '../../src/sports/registry.js';
import { createSportReducer } from '../../src/sports/shared/reducer.js';
import { createSportReplayFolder } from '../../src/sports/shared/replay.js';
import { MatchService } from '../../src/core/match.service.js';
import type { DispatchAction } from '../../src/core/match.service.js';
import { MatchQueue } from '../../src/core/match-queue.js';
import { lifecycleGuard } from '../../src/core/lifecycle.js';
import { eventLogBuilder } from '../../src/core/event-log.js';
import { createReplayFn, foldEvents } from '../../src/core/snapshot.js';
import { correctResult, restoreResult, undoAction } from '../../src/core/undo.js';
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

const CONFIGS: Record<Sport, MatchConfig> = {
  basketball: BASKETBALL_DEFAULTS,
  futsal: FUTSAL_DEFAULTS,
  badminton: BADMINTON_DEFAULTS,
  volleyball: VOLLEYBALL_DEFAULTS,
};

function initialState(sport: Sport): MatchState {
  const config = CONFIGS[sport];
  const engine = builtInSportRegistry.get(sport);
  const timed = config.gameClock.mode === 'timed';

  return {
    version: 0,
    period: { index: 0, label: config.periods.labels?.[0] ?? 'Period 1', status: 'active' },
    clock: {
      mode: config.gameClock.mode,
      remainingMs: timed ? config.periods.durationMs : 0,
      isRunning: false,
      anchorServerTs: 0,
      lastDurableRemainingMs: timed ? config.periods.durationMs : 0,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: engine.init(config),
    flags: { clockExpired: false, periodComplete: false },
  };
}

function createMatchInput(
  sport: Sport,
  overrides: Partial<CreateMatchInput> = {},
): CreateMatchInput {
  return {
    sport,
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: CONFIGS[sport],
    context: {},
    matchStatus: 'live',
    resultDecision: 'undecided',
    state: initialState(sport),
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

function createService(registry: SportRegistry, sport: Sport) {
  const folder = createSportReplayFolder({ registry, config: CONFIGS[sport], sport });

  return {
    folder,
    service: new MatchService({
      authorize: async () => undefined,
      lifecycle: lifecycleGuard,
      reduce: createSportReducer(registry),
      buildEvents: eventLogBuilder,
      replay: createReplayFn(folder),
      loadMatch: loadMatchWithEvents,
      persist: ({ matchId, events, state }) => persistEventsAndState({ matchId, events, state }),
      queue: new MatchQueue(),
    }),
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_batch2_integration'));
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

describe('built-in registry', () => {
  it('registers all four MVP engines', () => {
    const registry = registerBuiltInEngines(new SportRegistry());

    expect(
      registry
        .list()
        .map((engine) => engine.sport)
        .sort(),
    ).toEqual(['badminton', 'basketball', 'futsal', 'volleyball']);
  });
});

describe('Batch 2 integration', () => {
  it('dispatches and replays a basketball score and foul', async () => {
    const { service, folder } = createService(builtInSportRegistry, 'basketball');
    const match = await createMatch(createMatchInput('basketball'));
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 2 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );
    await service.dispatch(
      matchId,
      action('foul.add', { txId: 'tx-foul', expectedVersion: 1, payload: { side: 'away' } }),
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(initialState('basketball'), loaded!.events, folder);

    expect(folded).toEqual(loaded!.match.state);
    expect(loaded!.match.state.sportState).toMatchObject({
      score: { home: 2, away: 0 },
      fouls: { home: 0, away: 1 },
    });
  });

  it('dispatches and replays a futsal goal and card', async () => {
    const { service, folder } = createService(builtInSportRegistry, 'futsal');
    const match = await createMatch(createMatchInput('futsal'));
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'away', points: 1 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );
    await service.dispatch(
      matchId,
      action('card.add', {
        txId: 'tx-card',
        expectedVersion: 1,
        payload: { side: 'home', card: 'yellow' },
      }),
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(initialState('futsal'), loaded!.events, folder);

    expect(folded).toEqual(loaded!.match.state);
    expect(loaded!.match.state.sportState).toMatchObject({
      score: { home: 0, away: 1 },
      cards: { home: { yellow: 1, red: 0 } },
    });
  });

  it('dispatches and replays badminton serve selection and a rally point', async () => {
    const { service, folder } = createService(builtInSportRegistry, 'badminton');
    const match = await createMatch(createMatchInput('badminton'));
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('badminton.serve.change', { payload: { side: 'home' } }),
      { actor: { type: 'operator', id: 'op-1' }, now: T0 },
    );
    await service.dispatch(
      matchId,
      action('score.change', {
        txId: 'tx-point',
        expectedVersion: 1,
        payload: { side: 'home', points: 1 },
      }),
      { actor: { type: 'operator', id: 'op-1' }, now: at(1) },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(initialState('badminton'), loaded!.events, folder);

    expect(folded).toEqual(loaded!.match.state);
    expect(loaded!.match.state.sportState).toMatchObject({
      servingSide: 'home',
      serviceCourt: 'left',
    });
  });

  it('dispatches and replays a volleyball rally point', async () => {
    const { service, folder } = createService(builtInSportRegistry, 'volleyball');
    const match = await createMatch(createMatchInput('volleyball'));
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 1 } }),
      {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(initialState('volleyball'), loaded!.events, folder);

    expect(folded).toEqual(loaded!.match.state);
    expect(loaded!.match.state.sportState).toMatchObject({
      sets: [{ home: 1, away: 0 }],
    });
  });

  it('rejects a basketball-only action on a volleyball match', async () => {
    const { service } = createService(builtInSportRegistry, 'volleyball');
    const match = await createMatch(createMatchInput('volleyball'));

    await expect(
      service.dispatch(match._id.toString(), action('foul.add', { payload: { side: 'home' } }), {
        actor: { type: 'operator', id: 'op-1' },
        now: T0,
      }),
    ).rejects.toMatchObject({ code: 'ACTION_NOT_SUPPORTED' });
  });

  it('undoes a basketball action through the shared pipeline', async () => {
    const { service, folder } = createService(builtInSportRegistry, 'basketball');
    const match = await createMatch(createMatchInput('basketball'));
    const matchId = match._id.toString();

    await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 3 } }),
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
      registry: builtInSportRegistry,
      folder,
      now: at(1),
    });

    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.match.state.sportState).toMatchObject({ score: { home: 0, away: 0 } });
    expect(loaded?.events.map((event) => event.type)).toContain('match.undo');
  });

  it('corrects a saved basketball result and restores a discarded result', async () => {
    const { folder } = createService(builtInSportRegistry, 'basketball');
    const saved = await createMatch(
      createMatchInput('basketball', {
        matchStatus: 'finished',
        resultDecision: 'saved',
      }),
    );
    const savedId = saved._id.toString();

    await correctResult({
      matchId: savedId,
      correction: { homeScore: 80, awayScore: 79 },
      reason: 'Koreksi skor akhir',
      actor: { type: 'operator', id: 'op-1' },
      registry: builtInSportRegistry,
      folder,
      now: T0,
    });

    const corrected = await findMatchById(savedId);
    expect(corrected?.matchStatus).toBe('finished');
    expect(corrected?.resultDecision).toBe('saved');
    expect(corrected?.state.sportState).toMatchObject({ score: { home: 80, away: 79 } });

    const discarded = await createMatch(
      createMatchInput('basketball', {
        matchStatus: 'finished',
        resultDecision: 'discarded',
      }),
    );
    const discardedId = discarded._id.toString();

    await restoreResult({
      matchId: discardedId,
      actor: { type: 'operator', id: 'op-1' },
      registry: builtInSportRegistry,
      folder,
      now: T0,
    });

    const restored = await findMatchById(discardedId);
    expect(restored?.matchStatus).toBe('finished');
    expect(restored?.resultDecision).toBe('undecided');
  });
});
