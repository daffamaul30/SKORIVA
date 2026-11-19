import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import {
  EventValidationError,
  assertEventCanBeDeleted,
  canHardDeleteEvent,
  validateCreateEvent,
  validateMatchEventLink,
} from '../../../src/modules/event/validation.js';
import { createEvent } from '../../../src/repositories/event.repo.js';
import { createMatch } from '../../../src/repositories/match.repo.js';
import type { CreateMatchInput } from '../../../src/repositories/match.repo.js';
import { EventModel, MatchEventModel, MatchModel } from '../../../src/models/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

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

function createMatchInput(overrides: Partial<CreateMatchInput> = {}): CreateMatchInput {
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
    owner: { type: 'account', id: new Types.ObjectId().toString() },
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t19_event'));
  await Promise.all([
    MatchModel.syncIndexes(),
    MatchEventModel.syncIndexes(),
    EventModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    MatchEventModel.deleteMany({}),
    MatchModel.deleteMany({}),
    EventModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('validateCreateEvent', () => {
  it('requires an account owner', async () => {
    await expect(validateCreateEvent({ sport: 'basketball' })).rejects.toMatchObject({
      code: 'EVENT_OWNER_REQUIRED',
    });
  });

  it('accepts a top-level event owned by an account', async () => {
    const parent = await createEvent({
      name: 'Campus Sports Week',
      sport: 'basketball',
      ownerId: new Types.ObjectId().toString(),
    });

    await expect(
      validateCreateEvent({ sport: 'basketball', ownerId: parent.ownerId.toString() }),
    ).resolves.toBeNull();
  });

  it('rejects a missing parent', async () => {
    await expect(
      validateCreateEvent({
        sport: 'basketball',
        ownerId: new Types.ObjectId().toString(),
        parentId: new Types.ObjectId().toString(),
      }),
    ).rejects.toMatchObject({ code: 'PARENT_EVENT_NOT_FOUND' });
  });

  it('rejects a grandchild (depth > 2)', async () => {
    const ownerId = new Types.ObjectId().toString();
    const parent = await createEvent({ name: 'Parent', sport: 'basketball', ownerId });
    const child = await createEvent({
      name: 'Child',
      sport: 'basketball',
      ownerId,
      parentId: parent._id.toString(),
    });

    await expect(
      validateCreateEvent({ sport: 'basketball', ownerId, parentId: child._id.toString() }),
    ).rejects.toMatchObject({ code: 'EVENT_DEPTH_EXCEEDED' });
  });

  it('rejects child sport and owner mismatches', async () => {
    const ownerId = new Types.ObjectId().toString();
    const parent = await createEvent({ name: 'Parent', sport: 'basketball', ownerId });

    await expect(
      validateCreateEvent({ sport: 'volleyball', ownerId, parentId: parent._id.toString() }),
    ).rejects.toMatchObject({ code: 'EVENT_SPORT_MISMATCH' });

    await expect(
      validateCreateEvent({
        sport: 'basketball',
        ownerId: new Types.ObjectId().toString(),
        parentId: parent._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'EVENT_OWNER_MISMATCH' });
  });

  it('accepts a same-sport, same-owner child', async () => {
    const ownerId = new Types.ObjectId().toString();
    const parent = await createEvent({ name: 'Parent', sport: 'basketball', ownerId });

    await expect(
      validateCreateEvent({ sport: 'basketball', ownerId, parentId: parent._id.toString() }),
    ).resolves.toMatchObject({ _id: parent._id });
  });
});

describe('validateMatchEventLink', () => {
  it('accepts same sport and same owner', async () => {
    const ownerId = new Types.ObjectId().toString();
    const event = await createEvent({ name: 'Event', sport: 'basketball', ownerId });

    expect(() =>
      validateMatchEventLink(
        { sport: 'basketball', owner: { type: 'account', id: ownerId } },
        event,
      ),
    ).not.toThrow();
  });

  it('rejects sport and owner mismatches', async () => {
    const ownerId = new Types.ObjectId().toString();
    const event = await createEvent({ name: 'Event', sport: 'basketball', ownerId });

    expect(() =>
      validateMatchEventLink({ sport: 'futsal', owner: { type: 'account', id: ownerId } }, event),
    ).toThrow(expect.objectContaining({ code: 'MATCH_EVENT_SPORT_MISMATCH' }));

    expect(() =>
      validateMatchEventLink(
        { sport: 'basketball', owner: { type: 'account', id: new Types.ObjectId().toString() } },
        event,
      ),
    ).toThrow(expect.objectContaining({ code: 'MATCH_EVENT_OWNER_MISMATCH' }));
  });
});

describe('event deletion guard', () => {
  it('allows deletion only when there are no matches or children', async () => {
    const ownerId = new Types.ObjectId().toString();
    const event = await createEvent({ name: 'Event', sport: 'basketball', ownerId });

    expect(await canHardDeleteEvent(event._id.toString())).toBe(true);
    await expect(assertEventCanBeDeleted(event._id.toString())).resolves.toBeUndefined();

    await createMatch(
      createMatchInput({
        context: { eventId: event._id },
        owner: { type: 'account', id: ownerId },
      }),
    );

    expect(await canHardDeleteEvent(event._id.toString())).toBe(false);
    await expect(assertEventCanBeDeleted(event._id.toString())).rejects.toBeInstanceOf(
      EventValidationError,
    );
  });

  it('blocks deletion when a child event exists', async () => {
    const ownerId = new Types.ObjectId().toString();
    const parent = await createEvent({ name: 'Parent', sport: 'basketball', ownerId });
    await createEvent({
      name: 'Child',
      sport: 'basketball',
      ownerId,
      parentId: parent._id.toString(),
    });

    expect(await canHardDeleteEvent(parent._id.toString())).toBe(false);
  });
});
