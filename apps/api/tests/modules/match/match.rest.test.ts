import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import { createApp } from '../../../src/app.js';
import { env } from '../../../src/config/env.js';
import { claimOperatorSession } from '../../../src/access/operator-session.js';
import { dispatchLifecycle } from '../../../src/modules/match/match.service.js';
import { setMatchChangePublisher } from '../../../src/modules/match/match.publisher.js';
import { createEvent } from '../../../src/repositories/event.repo.js';
import { findMatchEvents } from '../../../src/repositories/match.repo.js';
import {
  AccountModel,
  EventModel,
  MatchEventModel,
  MatchModel,
} from '../../../src/models/index.js';

const PASSWORD = 'password123';
const T0 = new Date('2026-11-14T10:00:00.000Z');

let mongod: MongoMemoryServer | undefined;

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: BASKETBALL_DEFAULTS,
    ...overrides,
  };
}

async function registerAndLogin(email: string) {
  const app = createApp();
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send({ email, password: PASSWORD });
  await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  return agent;
}

async function createMatch(agent?: ReturnType<typeof request.agent>) {
  const client = agent ?? request(createApp());
  const response = await client.post('/api/matches').send(createBody());
  expect(response.status).toBe(201);
  return response.body as {
    match: { id: string; owner: { type: string; id: string } };
    state: { version: number };
    controlToken: string;
    viewCode: string;
  };
}

async function operatorCredential(matchId: string): Promise<string> {
  const session = await claimOperatorSession(matchId, env.TOKEN_PEPPER, T0);
  return session.credential;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t29_rest'));
  await Promise.all([
    MatchModel.syncIndexes(),
    MatchEventModel.syncIndexes(),
    EventModel.syncIndexes(),
    AccountModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    MatchEventModel.deleteMany({}),
    MatchModel.deleteMany({}),
    EventModel.deleteMany({}),
    AccountModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('POST /api/matches', () => {
  it('creates an anonymous device match with credentials and a match.create meta event', async () => {
    const created = await createMatch();

    expect(created.match.owner.type).toBe('device');
    expect(created.state.version).toBe(0);
    expect(created.controlToken).toBeTruthy();
    expect(created.viewCode).toBeTruthy();
    expect(created).not.toHaveProperty('access');

    const events = await findMatchEvents(created.match.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: 'match.create' });
  });

  it('creates an account-owned match when a session cookie is present', async () => {
    const agent = await registerAndLogin('owner@example.com');
    const created = await createMatch(agent);

    expect(created.match.owner.type).toBe('account');
  });

  it('rejects an invalid sport config', async () => {
    const response = await request(createApp())
      .post('/api/matches')
      .send(
        createBody({
          config: { ...BASKETBALL_DEFAULTS, gameClock: { mode: 'none' } },
        }),
      );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CONFIG');
  });

  it('links an account match to a same-owner event and rejects a device link', async () => {
    const agent = await registerAndLogin('event-owner@example.com');
    const me = await agent.get('/api/auth/me');
    const ownerId = me.body.id as string;
    const event = await createEvent({
      name: 'Campus League',
      sport: 'basketball',
      ownerId,
    });

    const linked = await agent
      .post('/api/matches')
      .send(createBody({ context: { eventId: event._id.toString() } }));
    expect(linked.status).toBe(201);

    const device = await request(createApp())
      .post('/api/matches')
      .send(createBody({ context: { eventId: event._id.toString() } }));
    expect(device.status).toBe(400);
    expect(device.body.code).toBe('MATCH_EVENT_OWNER_MISMATCH');
  });
});

describe('GET /api/matches/:id', () => {
  it('returns the operator payload with state and display', async () => {
    const created = await createMatch();
    const credential = await operatorCredential(created.match.id);

    const response = await request(createApp())
      .get(`/api/matches/${created.match.id}`)
      .set('X-Operator-Session', credential);

    expect(response.status).toBe(200);
    expect(response.body.match.id).toBe(created.match.id);
    expect(response.body.state.version).toBe(0);
    expect(response.body.display.score).toEqual({ home: 0, away: 0 });
    expect(response.body.match).not.toHaveProperty('access');
  });

  it('returns the viewer payload without state or event log', async () => {
    const created = await createMatch();

    const response = await request(createApp())
      .get(`/api/matches/${created.match.id}`)
      .query({ code: created.viewCode });

    expect(response.status).toBe(200);
    expect(response.body.display).toBeDefined();
    expect(response.body.matchStatus).toBe('ready');
    expect(response.body).not.toHaveProperty('state');
    expect(response.body).not.toHaveProperty('match');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects missing and invalid access', async () => {
    const created = await createMatch();

    const missing = await request(createApp()).get(`/api/matches/${created.match.id}`);
    expect(missing.status).toBe(401);

    const invalid = await request(createApp())
      .get(`/api/matches/${created.match.id}`)
      .query({ code: 'wrong' });
    expect(invalid.status).toBe(403);
  });

  it('hides the display for a finished-undecided viewer payload', async () => {
    const created = await createMatch();
    const credential = await operatorCredential(created.match.id);
    const client = request(createApp());

    await client
      .post(`/api/matches/${created.match.id}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${created.match.id}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });

    const viewer = await client
      .get(`/api/matches/${created.match.id}`)
      .query({ code: created.viewCode });

    expect(viewer.status).toBe(200);
    expect(viewer.body.matchStatus).toBe('finished');
    expect(viewer.body.resultDecision).toBe('undecided');
    expect(viewer.body.display).toBeUndefined();
  });
});

describe('PATCH /api/matches/:id', () => {
  it('updates teams while READY and records context.update', async () => {
    const created = await createMatch();
    const credential = await operatorCredential(created.match.id);

    const response = await request(createApp())
      .patch(`/api/matches/${created.match.id}`)
      .set('X-Operator-Session', credential)
      .send({ teams: { home: { name: 'Baru' }, away: { name: 'Lama' } } });

    expect(response.status).toBe(200);
    expect(response.body.match.teams.home.name).toBe('Baru');
    expect(response.body.state.version).toBe(2);

    const events = await findMatchEvents(created.match.id);
    expect(events.map((event) => event.type)).toEqual(['match.create', 'context.update']);
  });

  it('rejects PATCH after the match is live', async () => {
    const created = await createMatch();
    const credential = await operatorCredential(created.match.id);

    await request(createApp())
      .post(`/api/matches/${created.match.id}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });

    const response = await request(createApp())
      .patch(`/api/matches/${created.match.id}`)
      .set('X-Operator-Session', credential)
      .send({ teams: { home: { name: 'Baru' }, away: { name: 'Lama' } } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFIG_LOCKED');
  });
});

describe('lifecycle REST', () => {
  it('runs start → finish → save → correct with txId and expectedVersion', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const start = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ version: 2, matchStatus: 'live' });

    const finish = await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });
    expect(finish.status).toBe(200);
    expect(finish.body).toMatchObject({ version: 3, matchStatus: 'finished' });

    const save = await client
      .post(`/api/matches/${matchId}/save-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-save', expectedVersion: 3 });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({ version: 4, resultDecision: 'saved' });

    const correct = await client
      .post(`/api/matches/${matchId}/correct-result`)
      .set('X-Operator-Session', credential)
      .send({
        txId: 'tx-correct',
        expectedVersion: 4,
        reason: 'Koreksi skor',
        correction: { homeScore: 80, awayScore: 79 },
      });
    expect(correct.status).toBe(200);
    expect(correct.body).toMatchObject({
      version: 5,
      txId: 'tx-correct',
      before: { score: { home: 0, away: 0 } },
      after: { score: { home: 80, away: 79 } },
    });

    const match = await MatchModel.findById(matchId).lean().exec();
    expect(match?.matchStatus).toBe('finished');
    expect(match?.resultDecision).toBe('saved');
  });

  it('discards and restores a result', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });

    const discard = await client
      .post(`/api/matches/${matchId}/discard-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-discard', expectedVersion: 3 });
    expect(discard.status).toBe(200);
    expect(discard.body.resultDecision).toBe('discarded');

    const restore = await client
      .post(`/api/matches/${matchId}/restore-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-restore', expectedVersion: 4 });
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({
      matchStatus: 'finished',
      resultDecision: 'undecided',
    });
  });

  it('cancels a ready match and treats cancelled as terminal', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const cancel = await client
      .post(`/api/matches/${matchId}/cancel`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-cancel', expectedVersion: 0 });
    expect(cancel.status).toBe(200);
    expect(cancel.body.matchStatus).toBe('cancelled');

    const start = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 2 });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('MATCH_CANCELLED');
  });

  it('rejects an invalid transition and a stale expectedVersion', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const invalid = await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 0 });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe('INVALID_TRANSITION');

    const stale = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.currentVersion).toBe(0);
    expect(stale.body.snapshot).toBeDefined();
  });

  it('is idempotent for a repeated txId', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const first = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    expect(first.status).toBe(200);

    const duplicate = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 2 });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.version).toBe(2);

    const events = await findMatchEvents(matchId);
    expect(events.filter((event) => event.type === 'match.start')).toHaveLength(1);
  });

  it('rejects missing, invalid, revoked, and stale operator sessions', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const missing = await client
      .post(`/api/matches/${matchId}/start`)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('OPERATOR_SESSION_REQUIRED');

    const invalid = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', 'wrong')
      .send({ txId: 'tx-start', expectedVersion: 0 });
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('OPERATOR_SESSION_INVALID');

    await MatchModel.updateOne(
      { _id: matchId },
      { $set: { 'access.operatorSession.revokedAt': new Date() } },
    ).exec();
    const revoked = await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    expect(revoked.status).toBe(403);
    expect(revoked.body.code).toBe('OPERATOR_SESSION_REVOKED');
  });

  it('rejects a stale operator session after control is replaced', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);

    await MatchModel.updateOne(
      { _id: matchId },
      { $set: { activeOperatorId: 'another-session' } },
    ).exec();

    const response = await request(createApp())
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('OPERATOR_SESSION_STALE');
  });

  it('reopens a finished undecided match and clears finishedAt', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });

    const finished = await MatchModel.findById(matchId).lean().exec();
    expect(finished?.finishedAt).toBeInstanceOf(Date);

    const reopen = await client
      .post(`/api/matches/${matchId}/reopen`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-reopen', expectedVersion: 3 });
    expect(reopen.status).toBe(200);
    expect(reopen.body.matchStatus).toBe('live');

    const reopened = await MatchModel.findById(matchId).lean().exec();
    expect(reopened?.finishedAt).toBeUndefined();
  });

  it('publishes lifecycle status after a REST commit', async () => {
    const publisher = { publishStatus: vi.fn(), publishPatch: vi.fn() };
    setMatchChangePublisher(publisher);

    try {
      const created = await createMatch();
      const credential = await operatorCredential(created.match.id);

      const response = await request(createApp())
        .post(`/api/matches/${created.match.id}/start`)
        .set('X-Operator-Session', credential)
        .send({ txId: 'tx-start', expectedVersion: 0 });

      expect(response.status).toBe(200);
      expect(publisher.publishStatus).toHaveBeenCalledOnce();
      expect(publisher.publishStatus.mock.calls[0]?.[0]).toMatchObject({
        matchStatus: 'live',
      });
    } finally {
      setMatchChangePublisher(undefined);
    }
  });

  it('does not expose REST handover or rotate endpoints', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    for (const path of ['handover', 'rotate-token', 'rotate-view-code']) {
      const response = await client
        .post(`/api/matches/${matchId}/${path}`)
        .set('X-Operator-Session', credential)
        .send({});
      expect(response.status).toBe(404);
    }
  });
});

describe('GET /api/matches/:id/events', () => {
  it('returns a paged operator event log and rejects viewers', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });

    const page = await client
      .get(`/api/matches/${matchId}/events`)
      .set('X-Operator-Session', credential)
      .query({ limit: 1 });
    expect(page.status).toBe(200);
    expect(page.body.events).toHaveLength(1);
    expect(page.body.events[0].type).toBe('match.start');
    expect(page.body.nextBeforeSeq).toBe(2);

    const viewer = await client
      .get(`/api/matches/${matchId}/events`)
      .query({ code: created.viewCode });
    expect(viewer.status).toBe(401);
  });
});

describe('GET /api/matches/:id/result', () => {
  it('returns the final display only for saved results', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    const undecided = await client
      .get(`/api/matches/${matchId}/result`)
      .query({ code: created.viewCode });
    expect(undecided.status).toBe(200);
    expect(undecided.body.display).toBeUndefined();

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });
    await client
      .post(`/api/matches/${matchId}/save-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-save', expectedVersion: 3 });

    const saved = await client
      .get(`/api/matches/${matchId}/result`)
      .query({ code: created.viewCode });
    expect(saved.status).toBe(200);
    expect(saved.body.display).toBeDefined();
    expect(saved.body.display.score).toEqual({ home: 0, away: 0 });
  });

  it('rejects a missing or invalid viewer code', async () => {
    const created = await createMatch();

    const missing = await request(createApp()).get(`/api/matches/${created.match.id}/result`);
    expect(missing.status).toBe(401);

    const invalid = await request(createApp())
      .get(`/api/matches/${created.match.id}/result`)
      .query({ code: 'wrong' });
    expect(invalid.status).toBe(403);
  });
});

describe('idempotency and concurrency', () => {
  it('keeps correction idempotent for the same txId', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });
    await client
      .post(`/api/matches/${matchId}/save-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-save', expectedVersion: 3 });

    const body = {
      txId: 'tx-correct',
      expectedVersion: 4,
      reason: 'Koreksi',
      correction: { homeScore: 10, awayScore: 9 },
    };
    const first = await client
      .post(`/api/matches/${matchId}/correct-result`)
      .set('X-Operator-Session', credential)
      .send(body);
    expect(first.status).toBe(200);

    const duplicate = await client
      .post(`/api/matches/${matchId}/correct-result`)
      .set('X-Operator-Session', credential)
      .send({ ...body, expectedVersion: 5 });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.before).toEqual(first.body.before);
    expect(duplicate.body.after).toEqual(first.body.after);

    const events = await findMatchEvents(matchId);
    expect(events.filter((event) => event.type === 'result.correct')).toHaveLength(1);
  });

  it('keeps restore idempotent for the same txId', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);
    const client = request(createApp());

    await client
      .post(`/api/matches/${matchId}/start`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-start', expectedVersion: 0 });
    await client
      .post(`/api/matches/${matchId}/finish`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-finish', expectedVersion: 2 });
    await client
      .post(`/api/matches/${matchId}/discard-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-discard', expectedVersion: 3 });

    const first = await client
      .post(`/api/matches/${matchId}/restore-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-restore', expectedVersion: 4 });
    expect(first.status).toBe(200);

    const duplicate = await client
      .post(`/api/matches/${matchId}/restore-result`)
      .set('X-Operator-Session', credential)
      .send({ txId: 'tx-restore', expectedVersion: 5 });
    expect(duplicate.status).toBe(200);

    const events = await findMatchEvents(matchId);
    expect(events.filter((event) => event.type === 'result.restore')).toHaveLength(1);
  });

  it('serializes concurrent lifecycle actions through one queue', async () => {
    const created = await createMatch();
    const matchId = created.match.id;
    const credential = await operatorCredential(matchId);

    const [start, cancel] = await Promise.all([
      dispatchLifecycle(matchId, 'start', { txId: 'tx-start', expectedVersion: 0 }, credential),
      dispatchLifecycle(matchId, 'cancel', { txId: 'tx-cancel', expectedVersion: 0 }, credential),
    ]);

    const statuses = [start.status, cancel.status].sort();
    expect(statuses).toEqual(['committed', 'version_conflict']);
  });
});

describe('POST /api/matches/:id/claim', () => {
  it('claims a device match for an account and is idempotent for the same account', async () => {
    const created = await createMatch();
    const agent = await registerAndLogin('claim@example.com');

    const claim = await agent
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: created.controlToken });
    expect(claim.status).toBe(200);
    expect(claim.body.match.owner.type).toBe('account');

    const again = await agent
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: created.controlToken });
    expect(again.status).toBe(200);
  });

  it('rejects a different account, a wrong token, and an anonymous caller', async () => {
    const created = await createMatch();
    const first = await registerAndLogin('first@example.com');
    const second = await registerAndLogin('second@example.com');

    await first
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: created.controlToken });

    const different = await second
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: created.controlToken });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('MATCH_ALREADY_CLAIMED');

    const wrongToken = await request(createApp())
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: 'wrong' });
    expect(wrongToken.status).toBe(401);

    const anonymous = await request(createApp())
      .post(`/api/matches/${created.match.id}/claim`)
      .send({ controlToken: created.controlToken });
    expect(anonymous.status).toBe(401);
  });
});
