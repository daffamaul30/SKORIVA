import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import { createMatch, findMatchEvents, findMatchById } from '../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../src/repositories/match.repo.js';
import { MatchEventModel, MatchModel } from '../../src/models/index.js';
import { runtimeRegistry } from '../../src/core/runtime.registry.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';
import type { BasketballState } from '../../src/sports/basketball/state.js';
import { createShotClockExpiry } from '../../src/realtime/shot-clock.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let mongod: MongoMemoryServer | undefined;

class FakeGateway implements RealtimeGateway {
  patches: Array<{ matchId: string; role: string }> = [];
  join(): void {}
  leave(): void {}
  disconnectRole(): void {}
  broadcastPatch(matchId: string, _payload: unknown, roleFilter: string): void {
    this.patches.push({ matchId, role: roleFilter });
  }
  broadcastClock(): void {}
  broadcastStatus(): void {}
  broadcastOperatorState(): void {}
  emitTo(): void {}
}

function createState(): MatchState {
  const base = basketballEngine.init(BASKETBALL_DEFAULTS) as unknown as BasketballState;

  return {
    version: 0,
    period: { index: 0, label: 'Q1', status: 'active' },
    clock: {
      mode: 'timed',
      remainingMs: 600_000,
      isRunning: true,
      anchorServerTs: T0.getTime(),
      lastDurableRemainingMs: 600_000,
      lastDurableAt: T0,
      recoveryPending: false,
    },
    sportState: {
      ...base,
      shotClock: {
        ...base.shotClock,
        remainingMs: 1_000,
        running: true,
        anchorServerTs: T0.getTime(),
        expired: false,
      },
    },
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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t26_shot_clock'));
  await Promise.all([MatchModel.syncIndexes(), MatchEventModel.syncIndexes()]);
});

beforeEach(async () => {
  await Promise.all([MatchEventModel.deleteMany({}), MatchModel.deleteMany({})]);
  runtimeRegistry.clear();
});

afterAll(async () => {
  runtimeRegistry.clear();
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('shot clock expiry transition', () => {
  it('persists shotClock.expired + clock.pause once and is idempotent', async () => {
    const match = await createMatch(createMatchInput());
    const matchId = match._id.toString();
    const gateway = new FakeGateway();
    const expire = createShotClockExpiry({ gateway, now: () => at(1) });

    await expire(matchId);

    const events = await findMatchEvents(matchId);
    expect(events.map((event) => event.type)).toEqual(['shotClock.expired', 'clock.pause']);

    const loaded = await findMatchById(matchId);
    expect(loaded?.state.version).toBe(2);
    expect(loaded?.state.clock.isRunning).toBe(false);
    expect((loaded?.state.sportState as unknown as BasketballState).shotClock.expired).toBe(true);
    expect(gateway.patches.map((item) => item.role)).toEqual(['operator', 'viewer']);

    await expire(matchId);

    expect(await findMatchEvents(matchId)).toHaveLength(2);
  });

  it('does nothing when the match is not live', async () => {
    const match = await createMatch({
      ...createMatchInput(),
      matchStatus: 'finished',
    });
    const matchId = match._id.toString();
    const gateway = new FakeGateway();
    const expire = createShotClockExpiry({ gateway, now: () => at(1) });

    await expire(matchId);

    expect(await findMatchEvents(matchId)).toHaveLength(0);
    expect(gateway.patches).toHaveLength(0);
  });
});
