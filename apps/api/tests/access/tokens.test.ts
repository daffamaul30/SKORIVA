import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchModel } from '../../src/models/index.js';
import { createMatch } from '../../src/repositories/match.repo.js';
import {
  AccessError,
  CONTROL_TOKEN_BYTES,
  VIEW_CODE_BYTES,
  createMatchCredentials,
  generateOpaqueToken,
  hashOpaqueToken,
  TOKEN_DOMAINS,
  rotateControlToken,
  rotateViewCode,
} from '../../src/access/tokens.js';
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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri('skoriva_t09_tokens'));
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

describe('opaque token generation', () => {
  it('generates base64url tokens with the requested byte length', () => {
    const token = generateOpaqueToken(CONTROL_TOKEN_BYTES);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(43);
  });

  it('generates a 128-bit view code', () => {
    const viewCode = generateOpaqueToken(VIEW_CODE_BYTES);

    expect(viewCode).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(viewCode).toHaveLength(22);
  });

  it('generates different values on each call', () => {
    expect(generateOpaqueToken(32)).not.toBe(generateOpaqueToken(32));
  });

  it('rejects invalid byte lengths', () => {
    expect(() => generateOpaqueToken(0)).toThrow('positive integer');
    expect(() => generateOpaqueToken(-1)).toThrow('positive integer');
    expect(() => generateOpaqueToken(1.5)).toThrow('positive integer');
  });
});

describe('token hashing', () => {
  it('is deterministic and produces a 64-character hex digest', () => {
    const token = 'opaque-token';
    const first = hashOpaqueToken(token, PEPPER, TOKEN_DOMAINS.controlToken);
    const second = hashOpaqueToken(token, PEPPER, TOKEN_DOMAINS.controlToken);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when the token or pepper changes', () => {
    const token = 'opaque-token';

    expect(hashOpaqueToken(token, PEPPER, TOKEN_DOMAINS.controlToken)).not.toBe(
      hashOpaqueToken(`${token}-x`, PEPPER, TOKEN_DOMAINS.controlToken),
    );
    expect(hashOpaqueToken(token, PEPPER, TOKEN_DOMAINS.controlToken)).not.toBe(
      hashOpaqueToken(token, 'another-pepper-0123456789abcdef012345', TOKEN_DOMAINS.controlToken),
    );
  });

  it('separates domains so the same value never matches another credential class', () => {
    const value = 'same-value';

    const control = hashOpaqueToken(value, PEPPER, TOKEN_DOMAINS.controlToken);
    const view = hashOpaqueToken(value, PEPPER, TOKEN_DOMAINS.viewCode);
    const session = hashOpaqueToken(value, PEPPER, TOKEN_DOMAINS.operatorSession);
    const handover = hashOpaqueToken(value, PEPPER, TOKEN_DOMAINS.handoverCode);

    expect(new Set([control, view, session, handover]).size).toBe(4);
  });

  it('rejects empty token or pepper', () => {
    expect(() => hashOpaqueToken('', PEPPER, TOKEN_DOMAINS.controlToken)).toThrow(
      'Token must not be empty.',
    );
    expect(() => hashOpaqueToken('token', '', TOKEN_DOMAINS.controlToken)).toThrow(
      'TOKEN_PEPPER must not be empty.',
    );
  });
});

describe('createMatchCredentials', () => {
  it('returns plaintext once and stores only hashes in access', () => {
    const credentials = createMatchCredentials(PEPPER, now);

    expect(credentials.controlToken).toHaveLength(43);
    expect(credentials.viewCode).toHaveLength(22);
    expect(credentials.access.controlTokenHash).toBe(
      hashOpaqueToken(credentials.controlToken, PEPPER, TOKEN_DOMAINS.controlToken),
    );
    expect(credentials.access.viewCodeHash).toBe(
      hashOpaqueToken(credentials.viewCode, PEPPER, TOKEN_DOMAINS.viewCode),
    );
    expect(credentials.access.tokenIssuedAt).toEqual(now);
    expect(credentials.access.viewCodeIssuedAt).toEqual(now);
    expect(credentials.access.revokedTokenHashes).toEqual([]);
    expect(credentials.access.revokedViewCodeHashes).toEqual([]);

    const serialized = JSON.stringify(credentials.access);
    expect(serialized).not.toContain(credentials.controlToken);
    expect(serialized).not.toContain(credentials.viewCode);
  });
});

describe('rotation', () => {
  it('rotates the control token, revokes the old hash, and keeps status', async () => {
    const credentials = createMatchCredentials(PEPPER, now);
    const match = await createMatch(createMatchInput(credentials.access));
    const oldHash = credentials.access.controlTokenHash;
    const rotatedAt = new Date('2026-11-14T01:00:00.000Z');

    const rotated = await rotateControlToken(match._id.toString(), PEPPER, rotatedAt);

    expect(rotated.controlToken).not.toBe(credentials.controlToken);
    expect(rotated.issuedAt).toEqual(rotatedAt);

    const updated = await MatchModel.findById(match._id).lean().exec();
    expect(updated?.access.controlTokenHash).toBe(
      hashOpaqueToken(rotated.controlToken, PEPPER, TOKEN_DOMAINS.controlToken),
    );
    expect(updated?.access.controlTokenHash).not.toBe(oldHash);
    expect(updated?.access.revokedTokenHashes).toContain(oldHash);
    expect(updated?.access.tokenIssuedAt).toEqual(rotatedAt);
    expect(updated?.matchStatus).toBe('ready');
    expect(updated?.resultDecision).toBe('undecided');
  });

  it('rotates the view code, revokes the old hash, and keeps status', async () => {
    const credentials = createMatchCredentials(PEPPER, now);
    const match = await createMatch(createMatchInput(credentials.access));
    const oldHash = credentials.access.viewCodeHash;
    const rotatedAt = new Date('2026-11-14T02:00:00.000Z');

    const rotated = await rotateViewCode(match._id.toString(), PEPPER, rotatedAt);

    expect(rotated.viewCode).not.toBe(credentials.viewCode);
    expect(rotated.issuedAt).toEqual(rotatedAt);

    const updated = await MatchModel.findById(match._id).lean().exec();
    expect(updated?.access.viewCodeHash).toBe(
      hashOpaqueToken(rotated.viewCode, PEPPER, TOKEN_DOMAINS.viewCode),
    );
    expect(updated?.access.viewCodeHash).not.toBe(oldHash);
    expect(updated?.access.revokedViewCodeHashes).toContain(oldHash);
    expect(updated?.access.viewCodeIssuedAt).toEqual(rotatedAt);
    expect(updated?.matchStatus).toBe('ready');
    expect(updated?.resultDecision).toBe('undecided');
  });

  it('does not store rotated plaintext in the database', async () => {
    const credentials = createMatchCredentials(PEPPER, now);
    const match = await createMatch(createMatchInput(credentials.access));

    const rotatedToken = await rotateControlToken(match._id.toString(), PEPPER);
    const rotatedViewCode = await rotateViewCode(match._id.toString(), PEPPER);

    const stored = await MatchModel.findById(match._id).lean().exec();
    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain(rotatedToken.controlToken);
    expect(serialized).not.toContain(rotatedViewCode.viewCode);
  });

  it('throws MATCH_NOT_FOUND for an unknown match', async () => {
    await expect(rotateControlToken(new Types.ObjectId().toString(), PEPPER)).rejects.toMatchObject(
      { code: 'MATCH_NOT_FOUND' },
    );

    await expect(rotateViewCode(new Types.ObjectId().toString(), PEPPER)).rejects.toMatchObject({
      code: 'MATCH_NOT_FOUND',
    });
  });

  it('throws ACCESS_ROTATION_CONFLICT when the current hash no longer matches', async () => {
    const credentials = createMatchCredentials(PEPPER, now);
    const match = await createMatch(createMatchInput(credentials.access));
    const updateSpy = vi.spyOn(MatchModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: () => ({ exec: async () => null }),
    } as never);

    try {
      await expect(rotateControlToken(match._id.toString(), PEPPER)).rejects.toBeInstanceOf(
        AccessError,
      );
    } finally {
      updateSpy.mockRestore();
    }
  });
});
