/**
 * Batch 1 integration: T-11 through T-17 wired together.
 *
 * T-11 operator session → T-12 action pipeline → T-13 lifecycle guard →
 * T-14 event log → T-15 replay → T-16 clock → T-17 runtime registry.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import { env } from '../../src/config/env.js';
import {
  claimOperatorSession,
  markOperatorDisconnected,
  reconnectOperatorSession,
} from '../../src/access/operator-session.js';
import { MatchService } from '../../src/core/match.service.js';
import type { DispatchAction, StateReducer } from '../../src/core/match.service.js';
import { lifecycleGuard } from '../../src/core/lifecycle.js';
import { eventLogBuilder } from '../../src/core/event-log.js';
import { applyClockAction, applyClockEvent } from '../../src/core/clock.js';
import { composeFolders, createReplayFn, foldEvents } from '../../src/core/snapshot.js';
import type { EventFolder } from '../../src/core/snapshot.js';
import { MatchRuntimeRegistry } from '../../src/core/runtime.registry.js';
import {
  createMatch,
  findMatchEvents,
  loadMatchWithEvents,
  persistEventsAndState,
} from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

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

function scoreFolder(): EventFolder {
  return (state, event) => {
    if (event.type !== 'score.change') return state;
    const payload = event.payload as { side: 'home' | 'away'; points: number };
    const current = Number(state.sportState[payload.side] ?? 0);

    return {
      ...state,
      sportState: { ...state.sportState, [payload.side]: current + payload.points },
    };
  };
}

function clockFolder(): EventFolder {
  return (state, event) => applyClockEvent(state, event, BASKETBALL_DEFAULTS);
}

const batchFolder = composeFolders(clockFolder(), scoreFolder());

const batchReducer: StateReducer = (state, action, match, now) => {
  if (action.type.startsWith('clock.')) {
    return applyClockAction(state, action, match.config, now);
  }

  if (action.type === 'score.change') {
    const payload = action.payload as { side: 'home' | 'away'; points: number };
    const currentSportState = state.sportState ?? {};

    return {
      state: {
        ...state,
        sportState: {
          ...currentSportState,
          [payload.side]: Number(currentSportState[payload.side] ?? 0) + payload.points,
        },
      },
      emitted: ['score.change'],
    };
  }

  return { state, emitted: [action.type] };
};

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

function createBatchService(registry: MatchRuntimeRegistry): MatchService {
  return new MatchService({
    lifecycle: lifecycleGuard,
    reduce: batchReducer,
    buildEvents: eventLogBuilder,
    replay: createReplayFn(batchFolder),
    loadMatch: (matchId) => registry.loadMatch(matchId),
    persist: ({ matchId, events, state }) => persistEventsAndState({ matchId, events, state }),
    queue: registry.serialQueue,
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_batch1_integration'));
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

async function setup() {
  const match = await createMatch(createMatchInput());
  const matchId = match._id.toString();
  const session = await claimOperatorSession(matchId, env.TOKEN_PEPPER, T0);
  const registry = new MatchRuntimeRegistry({
    replay: batchFolder,
    now: () => T0,
  });
  const service = createBatchService(registry);

  return { matchId, credential: session.credential, registry, service };
}

describe('Batch 1 end-to-end', () => {
  it('processes clock and score actions through the full pipeline', async () => {
    const { matchId, credential, service } = await setup();
    const context = { actor: { type: 'operator' as const, id: 'op-1' }, now: T0 };

    const started = await service.dispatch(matchId, action('clock.start'), {
      ...context,
      operatorCredential: credential,
    });
    expect(started).toMatchObject({ status: 'committed', version: 1 });

    const pausedAt = at(60);
    const paused = await service.dispatch(
      matchId,
      action('clock.pause', { txId: 'tx-pause', expectedVersion: 1 }),
      { ...context, operatorCredential: credential, now: pausedAt },
    );
    expect(paused).toMatchObject({ status: 'committed', version: 2 });

    const scored = await service.dispatch(
      matchId,
      action('score.change', {
        txId: 'tx-score',
        expectedVersion: 2,
        payload: { side: 'home', points: 3 },
      }),
      { ...context, operatorCredential: credential, now: at(61) },
    );
    expect(scored).toMatchObject({ status: 'committed', version: 3 });

    const loaded = await loadMatchWithEvents(matchId);
    expect(loaded?.match.state.version).toBe(3);
    expect(loaded?.match.state.clock.remainingMs).toBe(540_000);
    expect(loaded?.match.state.clock.lastDurableRemainingMs).toBe(540_000);
    expect(loaded?.match.state.sportState.home).toBe(3);
    expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('is idempotent and rejects stale versions under concurrency', async () => {
    const { matchId, credential, service } = await setup();
    const context = { actor: { type: 'operator' as const, id: 'op-1' }, now: T0 };

    const [first, second] = await Promise.all([
      service.dispatch(
        matchId,
        action('score.change', { txId: 'tx-a', payload: { side: 'home', points: 2 } }),
        {
          ...context,
          operatorCredential: credential,
        },
      ),
      service.dispatch(
        matchId,
        action('score.change', { txId: 'tx-b', payload: { side: 'away', points: 2 } }),
        {
          ...context,
          operatorCredential: credential,
        },
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual(['committed', 'version_conflict']);
    expect(await findMatchEvents(matchId)).toHaveLength(1);

    const committed = first.status === 'committed' ? first : second;
    const duplicate = await service.dispatch(
      matchId,
      action('score.change', { txId: committed.txId, expectedVersion: 1 }),
      { ...context, operatorCredential: credential },
    );
    expect(duplicate.status).toBe('duplicate');
    expect(await findMatchEvents(matchId)).toHaveLength(1);
  });

  it('replays the event log to the same materialized state', async () => {
    const { matchId, credential, service } = await setup();
    const context = { actor: { type: 'operator' as const, id: 'op-1' }, now: T0 };

    await service.dispatch(matchId, action('clock.start'), {
      ...context,
      operatorCredential: credential,
    });
    await service.dispatch(
      matchId,
      action('score.change', {
        txId: 'tx-score',
        expectedVersion: 1,
        payload: { side: 'home', points: 2 },
      }),
      { ...context, operatorCredential: credential, now: at(5) },
    );

    const loaded = await loadMatchWithEvents(matchId);
    const folded = foldEvents(createState(), loaded!.events, batchFolder);

    expect(folded).toEqual(loaded!.match.state);
  });

  it('repairs a stale snapshot through the runtime registry', async () => {
    const { matchId, credential, service, registry } = await setup();
    const context = { actor: { type: 'operator' as const, id: 'op-1' }, now: T0 };

    await service.dispatch(
      matchId,
      action('score.change', {
        payload: { side: 'home', points: 2 },
      }),
      { ...context, operatorCredential: credential },
    );

    // Simulate a half-successful write: event exists, state stayed at v0.
    await persistEventsAndState({
      matchId,
      events: [
        {
          seq: 2,
          txId: 'tx-manual',
          type: 'score.change',
          payload: { side: 'away', points: 2 },
          actor: { type: 'operator', id: 'op-1' },
          serverTs: T0,
          appliedAt: T0,
        },
      ],
      state: createState(0),
    });

    registry.evict(matchId);
    const hydrated = await registry.loadMatch(matchId);

    expect(hydrated?.match.state.version).toBe(2);
    expect(hydrated?.match.state.sportState).toEqual({ home: 2, away: 2 });
    expect(hydrated?.needsReplay).toBe(false);
  });

  it('reconnects within the grace window and rejects after it', async () => {
    const { matchId, credential, service } = await setup();
    const context = { actor: { type: 'operator' as const, id: 'op-1' } };

    await markOperatorDisconnected(matchId, credential, env.TOKEN_PEPPER, T0);
    await reconnectOperatorSession(matchId, credential, env.TOKEN_PEPPER, at(10));

    const withinGrace = await service.dispatch(
      matchId,
      action('score.change', { payload: { side: 'home', points: 2 } }),
      { ...context, operatorCredential: credential, now: at(10) },
    );
    expect(withinGrace.status).toBe('committed');

    await markOperatorDisconnected(matchId, credential, env.TOKEN_PEPPER, at(20));

    await expect(
      service.dispatch(
        matchId,
        action('score.change', {
          txId: 'tx-late',
          expectedVersion: 1,
          payload: { side: 'home', points: 2 },
        }),
        { ...context, operatorCredential: credential, now: at(60) },
      ),
    ).rejects.toMatchObject({ code: 'OPERATOR_SESSION_EXPIRED' });
  });

  it('enforces lifecycle before reducing', async () => {
    const match = await createMatch(createMatchInput({ matchStatus: 'finished' }));
    const matchId = match._id.toString();
    const session = await claimOperatorSession(matchId, env.TOKEN_PEPPER, T0);
    const registry = new MatchRuntimeRegistry({ replay: batchFolder, now: () => T0 });
    const service = createBatchService(registry);

    await expect(
      service.dispatch(matchId, action('score.change', { payload: { side: 'home', points: 2 } }), {
        actor: { type: 'operator', id: 'op-1' },
        operatorCredential: session.credential,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: 'OPERATIONAL_NOT_ALLOWED' });
  });
});
