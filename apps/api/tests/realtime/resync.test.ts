import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../src/models/index.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';
import type { JoinResult, RoomManager } from '../../src/realtime/rooms.js';
import { joinAndSync, sendSnapshot } from '../../src/realtime/resync.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

function state(): MatchState {
  return {
    version: 4,
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
    teams: {
      home: { name: 'Garuda' },
      away: { name: 'Rajawali' },
    },
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

class OrderGateway implements RealtimeGateway {
  calls: string[] = [];
  payloads: Array<{ event: string; payload: unknown }> = [];

  join(): void {
    this.calls.push('join');
  }
  leave(): void {}
  disconnectRole(): void {}
  broadcastPatch(): void {}
  broadcastClock(): void {}
  broadcastStatus(): void {}
  broadcastOperatorState(): void {}
  emitTo(_clientRef: string, event: string, payload: unknown): void {
    this.calls.push(`emit:${event}`);
    this.payloads.push({ event, payload });
  }
}

function fakeRooms(result: JoinResult, order: string[] = []): RoomManager {
  return {
    joinOperator: vi.fn(async () => {
      order.push('joinOperator');
      return result;
    }),
    joinViewer: vi.fn(async () => {
      order.push('joinViewer');
      return result;
    }),
  } as unknown as RoomManager;
}

describe('joinAndSync', () => {
  it('subscribes first and then sends the operator snapshot and private session', async () => {
    const gateway = new OrderGateway();
    const current = match();
    const order: string[] = [];
    const rooms = fakeRooms(
      {
        ok: true,
        role: 'operator',
        match: current,
        sessionIssue: { sessionId: 's1', credential: 'credential', expiresAt: T0 },
      },
      order,
    );

    const result = await joinAndSync(
      'c1',
      { matchId: current._id.toString(), token: 't' },
      {
        rooms,
        gateway,
        now: () => T0,
      },
    );

    expect(result.ok).toBe(true);
    expect(order).toEqual(['joinOperator']);
    expect(gateway.calls).toEqual(['emit:match:snapshot', 'emit:operator:session']);
    expect(gateway.payloads[0]?.payload).toMatchObject({ version: 4 });
    expect(gateway.payloads[1]?.payload).toMatchObject({ credential: 'credential' });
  });

  it('sends a viewer snapshot and the current operator state', async () => {
    const gateway = new OrderGateway();
    const current = match();
    const rooms = fakeRooms({ ok: true, role: 'viewer', match: current });

    await joinAndSync(
      'v1',
      { matchId: current._id.toString(), viewCode: 'code' },
      {
        rooms,
        gateway,
        now: () => T0,
      },
    );

    expect(gateway.calls).toEqual(['emit:match:snapshot', 'emit:operator:state']);
    const snapshot = gateway.payloads[0]?.payload as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('state');
    expect(snapshot.version).toBe(4);
  });

  it('emits match:error when access is rejected', async () => {
    const gateway = new OrderGateway();
    const rooms = fakeRooms({ ok: false, code: 'VIEW_CODE_INVALID', message: 'invalid' });

    const result = await joinAndSync(
      'v1',
      { matchId: 'm1', viewCode: 'bad' },
      {
        rooms,
        gateway,
        now: () => T0,
      },
    );

    expect(result.ok).toBe(false);
    expect(gateway.payloads[0]?.event).toBe('match:error');
    expect(gateway.payloads[0]?.payload).toMatchObject({ code: 'VIEW_CODE_INVALID' });
  });

  it('hides the display for a finished-undecided viewer snapshot', () => {
    const gateway = new OrderGateway();
    const current = match({ matchStatus: 'finished', resultDecision: 'undecided' });

    sendSnapshot('v1', current, 'viewer', gateway, T0);

    const payload = gateway.payloads[0]?.payload as Record<string, unknown>;
    expect(payload.display).toBeUndefined();
    expect(payload.matchStatus).toBe('finished');
  });
});
