import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  archiveEventSchema as sharedArchiveEventSchema,
  createEventSchema as sharedCreateEventSchema,
  updateEventSchema as sharedUpdateEventSchema,
  BASKETBALL_DEFAULTS,
} from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../../src/models/index.js';
import {
  archiveEventSchema,
  createEventSchema,
  updateEventSchema,
} from '../../../src/modules/event/event.schemas.js';
import {
  toEventGroups,
  toEventMatchSummary,
} from '../../../src/modules/event/event.serializers.js';
import { basketballEngine } from '../../../src/sports/basketball/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function state(): MatchState {
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
    sportState: basketballEngine.init(BASKETBALL_DEFAULTS),
    flags: { clockExpired: false, periodComplete: false },
  };
}

function match(input: {
  stageLabel?: string;
  matchNumber?: number;
  createdAt: Date;
}): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda' },
      away: { name: 'Rajawali' },
    },
    config: BASKETBALL_DEFAULTS,
    context: {
      ...(input.stageLabel ? { stageLabel: input.stageLabel } : {}),
      ...(input.matchNumber !== undefined ? { matchNumber: input.matchNumber } : {}),
    },
    matchStatus: 'ready',
    resultDecision: 'undecided',
    state: state(),
    access: {
      controlTokenHash: 'control',
      viewCodeHash: 'view',
      viewCodeIssuedAt: T0,
      tokenIssuedAt: T0,
      revokedTokenHashes: [],
      revokedViewCodeHashes: [],
    },
    owner: { type: 'account', id: new Types.ObjectId().toString() },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  } as MatchDocument;
}

describe('event schema parity with @skoriva/shared', () => {
  it('accepts the same valid create payload', () => {
    const valid = { name: 'Campus League', sport: 'basketball' };

    expect(createEventSchema.safeParse(valid).success).toBe(true);
    expect(sharedCreateEventSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects ownerId and archived in both create schemas', () => {
    const withOwner = { name: 'X', sport: 'basketball', ownerId: 'a' };
    const withArchived = { name: 'X', sport: 'basketball', archived: true };

    expect(createEventSchema.safeParse(withOwner).success).toBe(false);
    expect(sharedCreateEventSchema.safeParse(withOwner).success).toBe(false);
    expect(createEventSchema.safeParse(withArchived).success).toBe(false);
    expect(sharedCreateEventSchema.safeParse(withArchived).success).toBe(false);
  });

  it('rejects an empty update in both schemas', () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false);
    expect(sharedUpdateEventSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an empty archive body in both schemas', () => {
    expect(archiveEventSchema.safeParse({}).success).toBe(true);
    expect(sharedArchiveEventSchema.safeParse({}).success).toBe(true);
  });
});

describe('event match grouping', () => {
  it('uses first-seen labels, matchNumber order, and a final null fallback', () => {
    const a2 = match({ stageLabel: 'Group A', matchNumber: 2, createdAt: at(2) });
    const a1 = match({ stageLabel: 'Group A', matchNumber: 1, createdAt: at(1) });
    const b = match({ stageLabel: 'Group B', createdAt: at(3) });
    const savedA = match({ stageLabel: 'Group A', createdAt: at(4) });
    const fallback = match({ createdAt: at(5) });

    const groups = toEventGroups([a2, a1, b, savedA, fallback], T0);

    expect(groups.map((group) => group.label)).toEqual(['Group A', 'Group B', null]);
    expect(groups[0]?.matches.map((item) => item.id)).toEqual([
      a1._id.toString(),
      a2._id.toString(),
      savedA._id.toString(),
    ]);
    expect(groups[1]?.matches[0]?.id).toBe(b._id.toString());
    expect(groups[2]?.matches[0]?.id).toBe(fallback._id.toString());
  });

  it('never exposes internal state or access in a match summary', () => {
    const summary = toEventMatchSummary(match({ stageLabel: 'A', createdAt: T0 }), T0);

    expect(summary).not.toHaveProperty('state');
    expect(summary).not.toHaveProperty('access');
    expect(summary).not.toHaveProperty('events');
    expect(summary.display).toBeDefined();
  });
});
