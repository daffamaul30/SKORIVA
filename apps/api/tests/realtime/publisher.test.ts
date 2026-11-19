import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../src/models/index.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';
import { createMatchChangePublisher } from '../../src/realtime/match-publisher.js';
import {
  publishMatchPatch,
  publishMatchStatus,
  setMatchChangePublisher,
} from '../../src/modules/match/match.publisher.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

function state(): MatchState {
  return {
    version: 2,
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

function match(overrides: Partial<MatchDocument> = {}): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    sport: 'basketball',
    teams: { home: { name: 'Garuda' }, away: { name: 'Rajawali' } },
    config: BASKETBALL_DEFAULTS,
    context: {},
    matchStatus: 'live',
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
    owner: { type: 'device', id: 'device-1' },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as MatchDocument;
}

class RecordingGateway implements RealtimeGateway {
  statuses: unknown[] = [];
  patches: Array<{ payload: unknown; role: string }> = [];
  join(): void {}
  leave(): void {}
  disconnectRole(): void {}
  broadcastPatch(_matchId: string, payload: unknown, roleFilter: string): void {
    this.patches.push({ payload, role: roleFilter });
  }
  broadcastClock(): void {}
  broadcastStatus(_matchId: string, payload: unknown): void {
    this.statuses.push(payload);
  }
  broadcastOperatorState(): void {}
  emitTo(): void {}
}

afterEach(() => {
  setMatchChangePublisher(undefined);
});

describe('MatchChangePublisher hook', () => {
  it('calls the configured publisher and clears on unset', () => {
    const publisher = { publishStatus: vi.fn(), publishPatch: vi.fn() };
    setMatchChangePublisher(publisher);
    const current = match();

    publishMatchStatus(current);
    publishMatchPatch(current);

    expect(publisher.publishStatus).toHaveBeenCalledWith(current);
    expect(publisher.publishPatch).toHaveBeenCalledWith(current);

    setMatchChangePublisher(undefined);
    publishMatchStatus(current);
    expect(publisher.publishStatus).toHaveBeenCalledTimes(1);
  });

  it('broadcasts status and role-scoped patches', () => {
    const gateway = new RecordingGateway();
    const publisher = createMatchChangePublisher(gateway);

    publisher.publishStatus(match());

    expect(gateway.statuses).toHaveLength(1);
    expect(gateway.patches.map((item) => item.role)).toEqual(['operator', 'viewer']);
  });

  it('does not throw when a broadcast fails, so the database commit stands', () => {
    const gateway = {
      broadcastStatus: () => {
        throw new Error('socket down');
      },
      broadcastPatch: () => {
        throw new Error('socket down');
      },
    } as unknown as RealtimeGateway;
    const publisher = createMatchChangePublisher(gateway);

    expect(() => publisher.publishStatus(match())).not.toThrow();
    expect(() => publisher.publishPatch(match())).not.toThrow();
  });
});
