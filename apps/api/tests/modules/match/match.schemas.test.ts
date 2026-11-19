import { describe, expect, it } from 'vitest';
import {
  createMatchSchema as sharedCreateMatchSchema,
  lifecycleActionSchema as sharedLifecycleActionSchema,
  updateMatchSchema as sharedUpdateMatchSchema,
} from '@skoriva/shared';
import {
  createMatchSchema,
  lifecycleBodySchema,
  updateMatchSchema,
} from '../../../src/modules/match/match.schemas.js';

const validCreate = {
  sport: 'basketball',
  teams: {
    home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
    away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
  },
};

describe('local match schemas parity with @skoriva/shared', () => {
  it('accepts the same valid create payload', () => {
    expect(createMatchSchema.safeParse(validCreate).success).toBe(true);
    expect(sharedCreateMatchSchema.safeParse(validCreate).success).toBe(true);
  });

  it('rejects the same invalid team payload', () => {
    const invalid = {
      ...validCreate,
      teams: {
        home: { name: 'Same' },
        away: { name: 'Same' },
      },
    };

    expect(createMatchSchema.safeParse(invalid).success).toBe(false);
    expect(sharedCreateMatchSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an empty update payload in both schemas', () => {
    expect(updateMatchSchema.safeParse({}).success).toBe(false);
    expect(sharedUpdateMatchSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the same lifecycle body', () => {
    const body = { txId: 'tx-1', expectedVersion: 0 };

    expect(lifecycleBodySchema.safeParse(body).success).toBe(true);
    expect(sharedLifecycleActionSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a negative expectedVersion in both schemas', () => {
    const body = { txId: 'tx-1', expectedVersion: -1 };

    expect(lifecycleBodySchema.safeParse(body).success).toBe(false);
    expect(sharedLifecycleActionSchema.safeParse(body).success).toBe(false);
  });
});
