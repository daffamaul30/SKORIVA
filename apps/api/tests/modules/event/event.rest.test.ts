import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASKETBALL_DEFAULTS, FUTSAL_DEFAULTS } from '@skoriva/shared';
import { createApp } from '../../../src/app.js';
import { env } from '../../../src/config/env.js';
import { claimOperatorSession } from '../../../src/access/operator-session.js';
import {
  AccountModel,
  EventModel,
  MatchEventModel,
  MatchModel,
} from '../../../src/models/index.js';

const PASSWORD = 'password123';

let mongod: MongoMemoryServer | undefined;
let app: ReturnType<typeof createApp>;
let owner: ReturnType<typeof request.agent>;
let other: ReturnType<typeof request.agent>;
let ownerId = '';

async function registerAndLogin(agent: ReturnType<typeof request.agent>, email: string) {
  await agent.post('/api/auth/register').send({ email, password: PASSWORD });
  await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  const me = await agent.get('/api/auth/me');
  return me.body.id as string;
}

async function createEvent(
  agent: ReturnType<typeof request.agent>,
  overrides: Record<string, unknown> = {},
) {
  const response = await agent.post('/api/events').send({
    name: 'Campus League',
    sport: 'basketball',
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; name: string; sport: string; parentId: string | null };
}

async function createMatch(
  agent: ReturnType<typeof request.agent>,
  eventId: string,
  context: Record<string, unknown> = {},
  sport: 'basketball' | 'futsal' = 'basketball',
) {
  const response = await agent.post('/api/matches').send({
    sport,
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: sport === 'basketball' ? BASKETBALL_DEFAULTS : FUTSAL_DEFAULTS,
    context: { eventId, ...context },
  });
  expect(response.status).toBe(201);
  return response.body as {
    match: { id: string };
    controlToken: string;
    viewCode: string;
  };
}

async function operatorCredential(matchId: string): Promise<string> {
  const session = await claimOperatorSession(matchId, env.TOKEN_PEPPER, new Date());
  return session.credential;
}

async function startMatch(
  agent: ReturnType<typeof request.agent>,
  matchId: string,
  credential: string,
  expectedVersion = 0,
) {
  const response = await agent
    .post(`/api/matches/${matchId}/start`)
    .set('X-Operator-Session', credential)
    .send({ txId: `start-${matchId}`, expectedVersion });
  expect(response.status).toBe(200);
}

async function finishMatch(
  agent: ReturnType<typeof request.agent>,
  matchId: string,
  credential: string,
  expectedVersion = 2,
) {
  const response = await agent
    .post(`/api/matches/${matchId}/finish`)
    .set('X-Operator-Session', credential)
    .send({ txId: `finish-${matchId}`, expectedVersion });
  expect(response.status).toBe(200);
}

async function saveResult(
  agent: ReturnType<typeof request.agent>,
  matchId: string,
  credential: string,
  expectedVersion = 3,
) {
  const response = await agent
    .post(`/api/matches/${matchId}/save-result`)
    .set('X-Operator-Session', credential)
    .send({ txId: `save-${matchId}`, expectedVersion });
  expect(response.status).toBe(200);
}

async function discardResult(
  agent: ReturnType<typeof request.agent>,
  matchId: string,
  credential: string,
  expectedVersion = 3,
) {
  const response = await agent
    .post(`/api/matches/${matchId}/discard-result`)
    .set('X-Operator-Session', credential)
    .send({ txId: `discard-${matchId}`, expectedVersion });
  expect(response.status).toBe(200);
}

async function cancelMatch(
  agent: ReturnType<typeof request.agent>,
  matchId: string,
  credential: string,
  expectedVersion = 0,
) {
  const response = await agent
    .post(`/api/matches/${matchId}/cancel`)
    .set('X-Operator-Session', credential)
    .send({ txId: `cancel-${matchId}`, expectedVersion });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t30_event'));
  await Promise.all([
    MatchModel.syncIndexes(),
    MatchEventModel.syncIndexes(),
    EventModel.syncIndexes(),
    AccountModel.syncIndexes(),
  ]);

  app = createApp();
  owner = request.agent(app);
  other = request.agent(app);
  ownerId = await registerAndLogin(owner, 'event-owner@example.com');
  await registerAndLogin(other, 'event-other@example.com');
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

describe('POST /api/events', () => {
  it('requires an account and derives ownerId from the account', async () => {
    const anonymous = await request(app).post('/api/events').send({
      name: 'Anonymous',
      sport: 'basketball',
    });
    expect(anonymous.status).toBe(401);

    const created = await createEvent(owner);
    expect(created).toMatchObject({ name: 'Campus League', sport: 'basketball' });

    const stored = await EventModel.findById(created.id).lean().exec();
    expect(stored?.ownerId.toString()).toBe(ownerId);
    expect(stored?.archived).toBe(false);
  });

  it('rejects ownerId/archived in the body and missing required fields', async () => {
    const withOwner = await owner.post('/api/events').send({
      name: 'Bad',
      sport: 'basketball',
      ownerId,
    });
    expect(withOwner.status).toBe(400);

    const withArchived = await owner.post('/api/events').send({
      name: 'Bad',
      sport: 'basketball',
      archived: true,
    });
    expect(withArchived.status).toBe(400);

    const missing = await owner.post('/api/events').send({ name: 'No sport' });
    expect(missing.status).toBe(400);
  });

  it('validates parent hierarchy, sport, and ownership', async () => {
    const parent = await createEvent(owner, { name: 'Parent' });

    const child = await createEvent(owner, { name: 'Child', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    const wrongSport = await owner.post('/api/events').send({
      name: 'Wrong sport',
      sport: 'futsal',
      parentId: parent.id,
    });
    expect(wrongSport.status).toBe(400);
    expect(wrongSport.body.code).toBe('EVENT_SPORT_MISMATCH');

    const wrongOwner = await other.post('/api/events').send({
      name: 'Wrong owner',
      sport: 'basketball',
      parentId: parent.id,
    });
    expect(wrongOwner.status).toBe(400);
    expect(wrongOwner.body.code).toBe('EVENT_OWNER_MISMATCH');

    const grandchild = await owner.post('/api/events').send({
      name: 'Grandchild',
      sport: 'basketball',
      parentId: child.id,
    });
    expect(grandchild.status).toBe(400);
    expect(grandchild.body.code).toBe('EVENT_DEPTH_EXCEEDED');

    const missingParent = await owner.post('/api/events').send({
      name: 'Missing parent',
      sport: 'basketball',
      parentId: new mongoose.Types.ObjectId().toString(),
    });
    expect(missingParent.status).toBe(404);
    expect(missingParent.body.code).toBe('PARENT_EVENT_NOT_FOUND');
  });
});

describe('GET /api/events', () => {
  it('returns only root events owned by the account, excluding archived', async () => {
    const root = await createEvent(owner, { name: 'Root' });
    await createEvent(owner, { name: 'Child', parentId: root.id });
    const archived = await createEvent(owner, { name: 'Archived' });
    await owner.post(`/api/events/${archived.id}/archive`).send({});
    await createEvent(other, { name: 'Other root' });

    const response = await owner.get('/api/events');

    expect(response.status).toBe(200);
    expect(response.body.events.map((event: { name: string }) => event.name)).toEqual(['Root']);
  });

  it('does not paginate in the MVP', async () => {
    await createEvent(owner, { name: 'One' });
    await createEvent(owner, { name: 'Two' });
    await createEvent(owner, { name: 'Three' });

    const response = await owner.get('/api/events');
    expect(response.body.events).toHaveLength(3);
  });
});

describe('GET/PATCH/archive event', () => {
  it('enforces owner access and archived behavior', async () => {
    const event = await createEvent(owner);

    const own = await owner.get(`/api/events/${event.id}`);
    expect(own.status).toBe(200);

    const foreign = await other.get(`/api/events/${event.id}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('EVENT_FORBIDDEN');

    const missing = await owner.get(`/api/events/${new mongoose.Types.ObjectId().toString()}`);
    expect(missing.status).toBe(404);

    const updated = await owner
      .patch(`/api/events/${event.id}`)
      .send({ name: 'Renamed', description: 'Updated', date: '2026-12-01T00:00:00.000Z' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Renamed');

    const empty = await owner.patch(`/api/events/${event.id}`).send({});
    expect(empty.status).toBe(400);

    const extra = await owner.patch(`/api/events/${event.id}`).send({ sport: 'futsal' });
    expect(extra.status).toBe(400);

    const archived = await owner.post(`/api/events/${event.id}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    const again = await owner.post(`/api/events/${event.id}/archive`).send({});
    expect(again.status).toBe(200);

    const archivedGet = await owner.get(`/api/events/${event.id}`);
    expect(archivedGet.status).toBe(200);

    const archivedPatch = await owner.patch(`/api/events/${event.id}`).send({ name: 'Nope' });
    expect(archivedPatch.status).toBe(409);
    expect(archivedPatch.body.code).toBe('EVENT_ARCHIVED');

    const list = await owner.get('/api/events');
    expect(list.body.events).toHaveLength(0);
  });
});

describe('GET /api/events/:id/matches', () => {
  it('groups, filters, and orders matches per BR-17', async () => {
    const event = await createEvent(owner);

    const a2 = await createMatch(owner, event.id, { stageLabel: 'Group A', matchNumber: 2 });
    const a1 = await createMatch(owner, event.id, { stageLabel: 'Group A', matchNumber: 1 });
    const live = await createMatch(owner, event.id, { stageLabel: 'Group B' });
    const saved = await createMatch(owner, event.id, { stageLabel: 'Group A' });
    const fallback = await createMatch(owner, event.id, {});
    const undecided = await createMatch(owner, event.id, { stageLabel: 'Hidden' });
    const discarded = await createMatch(owner, event.id, { stageLabel: 'Hidden' });
    const cancelled = await createMatch(owner, event.id, { stageLabel: 'Hidden' });

    const liveCredential = await operatorCredential(live.match.id);
    await startMatch(owner, live.match.id, liveCredential);

    const savedCredential = await operatorCredential(saved.match.id);
    await startMatch(owner, saved.match.id, savedCredential);
    await finishMatch(owner, saved.match.id, savedCredential);
    await saveResult(owner, saved.match.id, savedCredential);

    const undecidedCredential = await operatorCredential(undecided.match.id);
    await startMatch(owner, undecided.match.id, undecidedCredential);
    await finishMatch(owner, undecided.match.id, undecidedCredential);

    const discardedCredential = await operatorCredential(discarded.match.id);
    await startMatch(owner, discarded.match.id, discardedCredential);
    await finishMatch(owner, discarded.match.id, discardedCredential);
    await discardResult(owner, discarded.match.id, discardedCredential);

    const cancelledCredential = await operatorCredential(cancelled.match.id);
    await cancelMatch(owner, cancelled.match.id, cancelledCredential);

    const response = await owner.get(`/api/events/${event.id}/matches`);

    expect(response.status).toBe(200);
    expect(response.body.groups.map((group: { label: string | null }) => group.label)).toEqual([
      'Group A',
      'Group B',
      null,
    ]);

    const groupA = response.body.groups[0].matches.map((match: { id: string }) => match.id);
    expect(groupA).toEqual([a1.match.id, a2.match.id, saved.match.id]);

    const groupB = response.body.groups[1].matches;
    expect(groupB.map((match: { id: string }) => match.id)).toEqual([live.match.id]);
    expect(groupB[0].display).toBeDefined();

    const fallbackGroup = response.body.groups[2].matches;
    expect(fallbackGroup.map((match: { id: string }) => match.id)).toEqual([fallback.match.id]);

    const allIds = response.body.groups.flatMap((group: { matches: Array<{ id: string }> }) =>
      group.matches.map((match) => match.id),
    );
    expect(allIds).not.toContain(undecided.match.id);
    expect(allIds).not.toContain(discarded.match.id);
    expect(allIds).not.toContain(cancelled.match.id);

    for (const group of response.body.groups) {
      for (const match of group.matches) {
        expect(match).not.toHaveProperty('state');
        expect(match).not.toHaveProperty('access');
        expect(match).not.toHaveProperty('events');
        expect(match.display).toBeDefined();
      }
    }
  });

  it('rejects non-owners and allows archived events', async () => {
    const event = await createEvent(owner);
    await createMatch(owner, event.id, { stageLabel: 'Group A' });

    const foreign = await other.get(`/api/events/${event.id}/matches`);
    expect(foreign.status).toBe(403);

    await owner.post(`/api/events/${event.id}/archive`).send({});
    const archived = await owner.get(`/api/events/${event.id}/matches`);
    expect(archived.status).toBe(200);
    expect(archived.body.groups).toHaveLength(1);
  });
});

describe('GET /api/events/:id/children', () => {
  it('returns non-archived children and enforces ownership', async () => {
    const parent = await createEvent(owner, { name: 'Parent' });
    const child = await createEvent(owner, { name: 'Child', parentId: parent.id });
    const archivedChild = await createEvent(owner, { name: 'Archived child', parentId: parent.id });
    await owner.post(`/api/events/${archivedChild.id}/archive`).send({});

    const response = await owner.get(`/api/events/${parent.id}/children`);
    expect(response.status).toBe(200);
    expect(response.body.children.map((event: { id: string }) => event.id)).toEqual([child.id]);

    const foreign = await other.get(`/api/events/${parent.id}/children`);
    expect(foreign.status).toBe(403);
  });
});

describe('Match ↔ Event linking via Match REST', () => {
  it('links same-owner/same-sport matches and rejects device/cross-owner/sport mismatch', async () => {
    const event = await createEvent(owner);
    const linked = await createMatch(owner, event.id, { stageLabel: 'Group A' });

    const matches = await owner.get(`/api/events/${event.id}/matches`);
    expect(matches.body.groups[0].matches[0].id).toBe(linked.match.id);

    const device = await request(app)
      .post('/api/matches')
      .send({
        sport: 'basketball',
        teams: { home: { name: 'A' }, away: { name: 'B' } },
        config: BASKETBALL_DEFAULTS,
        context: { eventId: event.id },
      });
    expect(device.status).toBe(400);
    expect(device.body.code).toBe('MATCH_EVENT_OWNER_MISMATCH');

    const foreign = await other.post('/api/matches').send({
      sport: 'basketball',
      teams: { home: { name: 'A' }, away: { name: 'B' } },
      config: BASKETBALL_DEFAULTS,
      context: { eventId: event.id },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('MATCH_EVENT_OWNER_MISMATCH');

    const wrongSport = await owner.post('/api/matches').send({
      sport: 'futsal',
      teams: { home: { name: 'A' }, away: { name: 'B' } },
      config: FUTSAL_DEFAULTS,
      context: { eventId: event.id },
    });
    expect(wrongSport.status).toBe(400);
    expect(wrongSport.body.code).toBe('MATCH_EVENT_SPORT_MISMATCH');
  });

  it('rejects linking after LIVE and supports relink/unlink while READY', async () => {
    const eventA = await createEvent(owner, { name: 'A' });
    const eventB = await createEvent(owner, { name: 'B' });
    const match = await createMatch(owner, eventA.id, { stageLabel: 'Group A' });
    const credential = await operatorCredential(match.match.id);

    await startMatch(owner, match.match.id, credential);

    const afterLive = await owner
      .patch(`/api/matches/${match.match.id}`)
      .set('X-Operator-Session', credential)
      .send({ context: { eventId: eventB.id } });
    expect(afterLive.status).toBe(409);
    expect(afterLive.body.code).toBe('CONFIG_LOCKED');

    const ready = await createMatch(owner, eventA.id, { stageLabel: 'Group A' });
    const readyCredential = await operatorCredential(ready.match.id);

    const relink = await owner
      .patch(`/api/matches/${ready.match.id}`)
      .set('X-Operator-Session', readyCredential)
      .send({ context: { eventId: eventB.id } });
    expect(relink.status).toBe(200);

    const aMatches = await owner.get(`/api/events/${eventA.id}/matches`);
    const bMatches = await owner.get(`/api/events/${eventB.id}/matches`);
    expect(aMatches.body.groups[0].matches.map((item: { id: string }) => item.id)).toEqual([
      match.match.id,
    ]);
    expect(bMatches.body.groups[0].matches[0].id).toBe(ready.match.id);

    const unlink = await owner
      .patch(`/api/matches/${ready.match.id}`)
      .set('X-Operator-Session', readyCredential)
      .send({ context: {} });
    expect(unlink.status).toBe(200);

    const afterUnlink = await owner.get(`/api/events/${eventB.id}/matches`);
    expect(afterUnlink.body.groups).toHaveLength(0);
  });

  it('keeps standalone matches out of events', async () => {
    const event = await createEvent(owner);
    const standalone = await owner.post('/api/matches').send({
      sport: 'basketball',
      teams: { home: { name: 'A' }, away: { name: 'B' } },
      config: BASKETBALL_DEFAULTS,
    });
    expect(standalone.status).toBe(201);

    const matches = await owner.get(`/api/events/${event.id}/matches`);
    expect(matches.body.groups).toHaveLength(0);
  });
});

describe('negative scope and concurrency', () => {
  it('does not expose DELETE, unarchive, or Event link endpoints', async () => {
    const event = await createEvent(owner);
    const match = await createMatch(owner, event.id);

    expect((await owner.delete(`/api/events/${event.id}`)).status).toBe(404);
    expect((await owner.post(`/api/events/${event.id}/unarchive`).send({})).status).toBe(404);
    expect((await owner.post(`/api/events/${event.id}/matches`).send({})).status).toBe(404);
    expect((await owner.post(`/api/matches/${match.match.id}/link-event`).send({})).status).toBe(
      404,
    );
  });

  it('keeps archive idempotent and link races last-write-wins', async () => {
    const eventA = await createEvent(owner, { name: 'A' });
    const eventB = await createEvent(owner, { name: 'B' });
    const match = await createMatch(owner, eventA.id);
    const credential = await operatorCredential(match.match.id);

    const [archiveOne, archiveTwo] = await Promise.all([
      owner.post(`/api/events/${eventA.id}/archive`).send({}),
      owner.post(`/api/events/${eventA.id}/archive`).send({}),
    ]);
    expect(archiveOne.status).toBe(200);
    expect(archiveTwo.status).toBe(200);

    const [linkA, linkB] = await Promise.all([
      owner
        .patch(`/api/matches/${match.match.id}`)
        .set('X-Operator-Session', credential)
        .send({ context: { eventId: eventA.id } }),
      owner
        .patch(`/api/matches/${match.match.id}`)
        .set('X-Operator-Session', credential)
        .send({ context: { eventId: eventB.id } }),
    ]);
    expect(linkA.status).toBe(200);
    expect(linkB.status).toBe(200);

    const aMatches = await owner.get(`/api/events/${eventA.id}/matches`);
    const bMatches = await owner.get(`/api/events/${eventB.id}/matches`);
    const total =
      aMatches.body.groups.reduce(
        (count: number, group: { matches: unknown[] }) => count + group.matches.length,
        0,
      ) +
      bMatches.body.groups.reduce(
        (count: number, group: { matches: unknown[] }) => count + group.matches.length,
        0,
      );

    expect(total).toBe(1);
  });
});
