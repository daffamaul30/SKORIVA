import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MatchModel } from '../../src/models/index.js';
import { createMatch } from '../../src/repositories/match.repo.js';
import {
  createMatchCredentials,
  rotateControlToken,
  rotateViewCode,
} from '../../src/access/tokens.js';
import {
  resolveMatchAccess,
  resolveOperatorAccess,
  resolveViewerAccess,
} from '../../src/access/guard.js';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';

const PEPPER = 'test-pepper-0123456789abcdef0123456789';
const now = new Date('2026-11-14T00:00:00.000Z');

let mongod: MongoMemoryServer | undefined;

function createMatchInput(access: ReturnType<typeof createMatchCredentials>['access']) {
  return {
    sport: 'basketball' as const,
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
    },
    config: BASKETBALL_DEFAULTS,
    context: {},
    matchStatus: 'ready' as const,
    resultDecision: 'undecided' as const,
    state: {
      version: 0,
      period: { index: 0, label: 'Q1', status: 'active' as const },
      clock: {
        mode: 'timed' as const,
        remainingMs: 600_000,
        isRunning: false,
        anchorServerTs: 0,
        lastDurableRemainingMs: 600_000,
        lastDurableAt: now,
        recoveryPending: false,
      },
      sportState: {},
      flags: { clockExpired: false, periodComplete: false },
    },
    access,
    owner: { type: 'device' as const, id: 'device-1' },
  };
}

async function createMatchWithCredentials() {
  const credentials = createMatchCredentials(PEPPER, now);
  const match = await createMatch(createMatchInput(credentials.access));
  return { credentials, match };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t09_guard'));
  await MatchModel.syncIndexes();
});

beforeEach(async () => {
  await MatchModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('resolveMatchAccess', () => {
  it('resolves a valid control token as operator', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { controlToken: credentials.controlToken },
      PEPPER,
    );

    expect(grant?.role).toBe('operator');
    expect(grant?.match._id.toString()).toBe(match._id.toString());
  });

  it('resolves a valid view code as viewer', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { viewCode: credentials.viewCode },
      PEPPER,
    );

    expect(grant?.role).toBe('viewer');
    expect(grant?.match._id.toString()).toBe(match._id.toString());
  });

  it('rejects matchId without a view code', async () => {
    const { match } = await createMatchWithCredentials();

    expect(await resolveMatchAccess(match._id.toString(), {}, PEPPER)).toBeNull();
  });

  it('rejects an invalid view code', async () => {
    const { match } = await createMatchWithCredentials();

    expect(
      await resolveMatchAccess(match._id.toString(), { viewCode: 'wrong-code' }, PEPPER),
    ).toBeNull();
  });

  it('rejects a view code from another match', async () => {
    const first = await createMatchWithCredentials();
    const second = await createMatchWithCredentials();

    expect(
      await resolveMatchAccess(
        first.match._id.toString(),
        { viewCode: second.credentials.viewCode },
        PEPPER,
      ),
    ).toBeNull();
  });

  it('rejects a control token from another match', async () => {
    const first = await createMatchWithCredentials();
    const second = await createMatchWithCredentials();

    expect(
      await resolveMatchAccess(
        first.match._id.toString(),
        { controlToken: second.credentials.controlToken },
        PEPPER,
      ),
    ).toBeNull();
  });

  it('returns null for an invalid match id', async () => {
    const { credentials } = await createMatchWithCredentials();

    expect(
      await resolveMatchAccess('not-an-object-id', { viewCode: credentials.viewCode }, PEPPER),
    ).toBeNull();
  });

  it('prefers operator when both credentials are valid', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { controlToken: credentials.controlToken, viewCode: credentials.viewCode },
      PEPPER,
    );

    expect(grant?.role).toBe('operator');
  });

  it('falls back to viewer when the control token is invalid', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { controlToken: 'invalid-token', viewCode: credentials.viewCode },
      PEPPER,
    );

    expect(grant?.role).toBe('viewer');
  });
});

describe('role-specific helpers', () => {
  it('resolveOperatorAccess rejects a view code', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    expect(
      await resolveOperatorAccess(match._id.toString(), credentials.viewCode, PEPPER),
    ).toBeNull();
  });

  it('resolveViewerAccess rejects a control token', async () => {
    const { credentials, match } = await createMatchWithCredentials();

    expect(
      await resolveViewerAccess(match._id.toString(), credentials.controlToken, PEPPER),
    ).toBeNull();
  });
});

describe('rotation invalidates old credentials', () => {
  it('invalidates the old control token and accepts the new one', async () => {
    const { credentials, match } = await createMatchWithCredentials();
    const rotated = await rotateControlToken(match._id.toString(), PEPPER);

    expect(
      await resolveMatchAccess(
        match._id.toString(),
        { controlToken: credentials.controlToken },
        PEPPER,
      ),
    ).toBeNull();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { controlToken: rotated.controlToken },
      PEPPER,
    );
    expect(grant?.role).toBe('operator');
  });

  it('invalidates the old view code and accepts the new one', async () => {
    const { credentials, match } = await createMatchWithCredentials();
    const rotated = await rotateViewCode(match._id.toString(), PEPPER);

    expect(
      await resolveMatchAccess(match._id.toString(), { viewCode: credentials.viewCode }, PEPPER),
    ).toBeNull();

    const grant = await resolveMatchAccess(
      match._id.toString(),
      { viewCode: rotated.viewCode },
      PEPPER,
    );
    expect(grant?.role).toBe('viewer');
  });

  it('does not change match status or result decision on rotation', async () => {
    const { match } = await createMatchWithCredentials();

    await rotateControlToken(match._id.toString(), PEPPER);
    await rotateViewCode(match._id.toString(), PEPPER);

    const stored = await MatchModel.findById(match._id).lean().exec();
    expect(stored?.matchStatus).toBe('ready');
    expect(stored?.resultDecision).toBe('undecided');
  });
});
