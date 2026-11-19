import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventModel } from '../../src/models/index.js';
import * as eventRepo from '../../src/repositories/event.repo.js';
import {
  archiveEvent,
  countChildEvents,
  createEvent,
  findChildEvents,
  findEventById,
  findEventWithChildren,
  findEventsByOwner,
  updateEvent,
} from '../../src/repositories/event.repo.js';

let mongod: MongoMemoryServer | undefined;
const ownerId = new Types.ObjectId().toString();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t08_event'));
  await EventModel.syncIndexes();
});

beforeEach(async () => {
  await EventModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('createEvent / findEventById', () => {
  it('creates and reads an event', async () => {
    const created = await createEvent({
      name: 'Liga Kampus',
      sport: 'futsal',
      ownerId,
      description: 'Turnamen antar fakultas',
    });

    expect(created._id).toBeInstanceOf(Types.ObjectId);
    expect(created.ownerId.toString()).toBe(ownerId);
    expect(created.archived).toBe(false);

    const found = await findEventById(created._id.toString());
    expect(found?.name).toBe('Liga Kampus');
    expect(found?.sport).toBe('futsal');
  });

  it('returns null for an unknown event', async () => {
    expect(await findEventById(new Types.ObjectId().toString())).toBeNull();
  });
});

describe('event listing', () => {
  it('lists only non-archived events by owner by default', async () => {
    const active = await createEvent({ name: 'Active', sport: 'futsal', ownerId });
    const archived = await createEvent({ name: 'Archived', sport: 'futsal', ownerId });
    await archiveEvent(archived._id.toString());

    const defaultList = await findEventsByOwner(ownerId);
    const fullList = await findEventsByOwner(ownerId, { includeArchived: true });

    expect(defaultList.map((event) => event._id.toString())).toEqual([active._id.toString()]);
    expect(fullList).toHaveLength(2);
  });

  it('lists child events and can include archived children', async () => {
    const parent = await createEvent({ name: 'Parent', sport: 'badminton', ownerId });
    const childA = await createEvent({
      name: 'Child A',
      sport: 'badminton',
      ownerId,
      parentId: parent._id.toString(),
    });
    const childB = await createEvent({
      name: 'Child B',
      sport: 'badminton',
      ownerId,
      parentId: parent._id.toString(),
    });
    await archiveEvent(childB._id.toString());

    const defaultChildren = await findChildEvents(parent._id.toString());
    const allChildren = await findChildEvents(parent._id.toString(), { includeArchived: true });

    expect(defaultChildren.map((event) => event._id.toString())).toEqual([childA._id.toString()]);
    expect(allChildren).toHaveLength(2);
    expect(await countChildEvents(parent._id.toString())).toBe(2);
  });

  it('loads an event together with its children', async () => {
    const parent = await createEvent({ name: 'Parent', sport: 'volleyball', ownerId });
    await createEvent({
      name: 'Child',
      sport: 'volleyball',
      ownerId,
      parentId: parent._id.toString(),
    });

    const loaded = await findEventWithChildren(parent._id.toString());

    expect(loaded?.event.name).toBe('Parent');
    expect(loaded?.children).toHaveLength(1);
  });
});

describe('updateEvent', () => {
  it('updates name, description, and date', async () => {
    const event = await createEvent({ name: 'Old', sport: 'futsal', ownerId });
    const date = new Date('2026-12-01T00:00:00.000Z');

    const updated = await updateEvent(event._id.toString(), {
      name: 'New',
      description: 'Updated',
      date,
    });

    expect(updated?.name).toBe('New');
    expect(updated?.description).toBe('Updated');
    expect(updated?.date?.toISOString()).toBe(date.toISOString());
  });

  it('ignores fields outside the update allowlist', async () => {
    const event = await createEvent({ name: 'Old', sport: 'futsal', ownerId });

    await updateEvent(event._id.toString(), {
      name: 'New',
      sport: 'basketball',
      parentId: new Types.ObjectId().toString(),
      archive: true,
    } as never);

    const loaded = await findEventById(event._id.toString());
    expect(loaded?.sport).toBe('futsal');
    expect(loaded?.parentId).toBeUndefined();
    expect(loaded?.archived).toBe(false);
  });
});

describe('archiveEvent', () => {
  it('archives without deleting the event (BR-16)', async () => {
    const event = await createEvent({ name: 'Arsip', sport: 'futsal', ownerId });

    const archived = await archiveEvent(event._id.toString());

    expect(archived?.archived).toBe(true);
    expect(await findEventById(event._id.toString())).not.toBeNull();
    expect(await EventModel.countDocuments({ _id: event._id })).toBe(1);
  });

  it('does not expose a hard-delete helper', () => {
    expect('deleteEvent' in eventRepo).toBe(false);
    expect('removeEvent' in eventRepo).toBe(false);
  });
});
