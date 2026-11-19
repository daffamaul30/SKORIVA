import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { BADMINTON_DEFAULTS, BASKETBALL_DEFAULTS } from '@skoriva/shared';
import type { MatchState } from '@skoriva/shared';
import type { MatchDocument } from '../../src/models/index.js';
import { badmintonEngine } from '../../src/sports/badminton/index.js';
import { basketballEngine } from '../../src/sports/basketball/index.js';
import {
  toMatchErrorPayload,
  toMatchStatusPayload,
  toOperatorSessionPayload,
  toOperatorSnapshot,
  toOperatorStatePayload,
  toViewerSnapshot,
} from '../../src/realtime/serializers.js';

const T0 = new Date('2026-11-14T10:00:00.000Z');

function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    version: 3,
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
    ...overrides,
  };
}

function match(overrides: Partial<MatchDocument> = {}): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    sport: 'basketball',
    teams: {
      home: { name: 'Garuda', abbr: 'GRD', color: '#ff0000' },
      away: { name: 'Rajawali', abbr: 'RWJ', color: '#0000ff' },
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

describe('realtime serializers', () => {
  it('includes state and display for operators', () => {
    const payload = toOperatorSnapshot(match(), T0);

    expect(payload.matchId).toBeTruthy();
    expect(payload.version).toBe(3);
    expect(payload.state.version).toBe(3);
    expect(payload.display.score).toEqual({ home: 0, away: 0 });
    expect(payload.serverTs).toBe(T0.toISOString());
  });

  it('hides the display for non-public viewer results', () => {
    const ready = toViewerSnapshot(match({ matchStatus: 'ready' }), T0);
    const live = toViewerSnapshot(match({ matchStatus: 'live' }), T0);
    const undecided = toViewerSnapshot(
      match({ matchStatus: 'finished', resultDecision: 'undecided' }),
      T0,
    );
    const discarded = toViewerSnapshot(
      match({ matchStatus: 'finished', resultDecision: 'discarded' }),
      T0,
    );
    const cancelled = toViewerSnapshot(match({ matchStatus: 'cancelled' }), T0);
    const saved = toViewerSnapshot(match({ matchStatus: 'finished', resultDecision: 'saved' }), T0);

    expect(ready.display).toBeDefined();
    expect(live.display).toBeDefined();
    expect(undecided.display).toBeUndefined();
    expect(discarded.display).toBeUndefined();
    expect(cancelled.display).toBeUndefined();
    expect(saved.display).toBeDefined();
  });

  it('never includes internal state in the viewer payload', () => {
    const payload = toViewerSnapshot(match(), T0);

    expect(payload).not.toHaveProperty('state');
    expect(payload).not.toHaveProperty('access');
    expect(payload).not.toHaveProperty('events');
  });

  it('exposes badminton serve fields to viewers', () => {
    const badmintonState = badmintonEngine.init(BADMINTON_DEFAULTS) as unknown as Record<
      string,
      unknown
    >;
    const payload = toViewerSnapshot(
      match({
        sport: 'badminton',
        config: BADMINTON_DEFAULTS,
        state: state({
          clock: {
            mode: 'none',
            remainingMs: 0,
            isRunning: false,
            anchorServerTs: 0,
            lastDurableRemainingMs: 0,
            lastDurableAt: T0,
            recoveryPending: false,
          },
          sportState: {
            ...badmintonState,
            serverSelected: true,
            servingSide: 'home',
            serviceCourt: 'right',
          },
        }),
      }),
      T0,
    );

    expect(payload.display?.badmintonServe).toEqual({
      servingSide: 'home',
      serviceCourt: 'right',
    });
  });

  it('builds status, operator state, session, and error payloads', () => {
    expect(toMatchStatusPayload(match())).toMatchObject({
      matchStatus: 'live',
      resultDecision: 'undecided',
    });
    expect(toOperatorStatePayload({ active: true, actorRef: 's1', graceUntil: T0 })).toEqual({
      active: true,
      actorRef: 's1',
      graceUntil: T0.toISOString(),
    });
    expect(
      toOperatorSessionPayload({
        matchId: 'm1',
        sessionId: 's1',
        credential: 'secret',
        expiresAt: T0,
      }),
    ).toEqual({
      matchId: 'm1',
      sessionId: 's1',
      credential: 'secret',
      expiresAt: T0.toISOString(),
    });
    expect(
      toMatchErrorPayload({ code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 3 }),
    ).toEqual({ code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 3 });
  });
});
