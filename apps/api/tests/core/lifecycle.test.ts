import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { MatchStatus, ResultDecision } from '@skoriva/shared';
import {
  LifecycleError,
  assertConfigMutable,
  assertOperationalActionAllowed,
  canApplyLifecycleAction,
  resolveLifecycleTransition,
} from '../../src/core/lifecycle.js';
import type { LifecycleAction } from '../../src/core/lifecycle.js';
import type { DispatchAction } from '../../src/core/match.service.js';
import type { MatchDocument } from '../../src/models/index.js';

function match(
  matchStatus: MatchStatus,
  resultDecision: ResultDecision = 'undecided',
): MatchDocument {
  return {
    _id: new Types.ObjectId(),
    matchStatus,
    resultDecision,
  } as MatchDocument;
}

function dispatchAction(type: DispatchAction['type']): DispatchAction {
  return {
    type,
    payload: {},
    txId: 'tx-1',
    expectedVersion: 0,
  } as DispatchAction;
}

describe('valid lifecycle transitions', () => {
  const cases: Array<[MatchStatus, ResultDecision, LifecycleAction, MatchStatus, ResultDecision]> =
    [
      ['ready', 'undecided', 'start', 'live', 'undecided'],
      ['live', 'undecided', 'finish', 'finished', 'undecided'],
      ['ready', 'undecided', 'cancel', 'cancelled', 'undecided'],
      ['live', 'undecided', 'cancel', 'cancelled', 'undecided'],
      ['finished', 'undecided', 'reopen', 'live', 'undecided'],
      ['finished', 'undecided', 'save', 'finished', 'saved'],
      ['finished', 'undecided', 'discard', 'finished', 'discarded'],
      ['finished', 'discarded', 'restore', 'finished', 'undecided'],
      ['finished', 'saved', 'correct', 'finished', 'saved'],
    ];

  it.each(cases)('%s/%s + %s → %s/%s', (from, decision, action, to, toDecision) => {
    expect(resolveLifecycleTransition(match(from, decision), action)).toEqual({
      matchStatus: to,
      resultDecision: toDecision,
    });
  });
});

describe('invalid lifecycle transitions', () => {
  it.each<[MatchStatus, ResultDecision, LifecycleAction]>([
    ['live', 'undecided', 'start'],
    ['finished', 'undecided', 'start'],
    ['cancelled', 'undecided', 'start'],
    ['ready', 'undecided', 'finish'],
    ['cancelled', 'undecided', 'finish'],
    ['ready', 'undecided', 'save'],
    ['live', 'undecided', 'save'],
    ['ready', 'undecided', 'discard'],
    ['live', 'undecided', 'discard'],
    ['finished', 'discarded', 'save'],
    ['finished', 'saved', 'reopen'],
    ['finished', 'discarded', 'reopen'],
    ['finished', 'saved', 'save'],
    ['finished', 'saved', 'discard'],
    ['finished', 'undecided', 'correct'],
    ['finished', 'discarded', 'correct'],
    ['finished', 'undecided', 'restore'],
    ['finished', 'saved', 'restore'],
  ])('rejects %s/%s + %s', (status, decision, action) => {
    expect(() => resolveLifecycleTransition(match(status, decision), action)).toThrow(
      LifecycleError,
    );
    expect(canApplyLifecycleAction(match(status, decision), action)).toBe(false);
  });

  it('treats cancelled as terminal for every action', () => {
    const actions: LifecycleAction[] = [
      'start',
      'finish',
      'cancel',
      'reopen',
      'save',
      'discard',
      'restore',
      'correct',
    ];

    for (const action of actions) {
      expect(() => resolveLifecycleTransition(match('cancelled'), action)).toThrow(
        expect.objectContaining({ code: 'MATCH_CANCELLED' }),
      );
    }
  });

  it('points a saved reopen to the correction flow', () => {
    expect(() => resolveLifecycleTransition(match('finished', 'saved'), 'reopen')).toThrow(
      expect.objectContaining({ code: 'REOPEN_SAVED_USE_CORRECT' }),
    );
  });

  it('points a discarded save to restore', () => {
    expect(() => resolveLifecycleTransition(match('finished', 'discarded'), 'save')).toThrow(
      expect.objectContaining({ code: 'SAVE_REQUIRES_RESTORE' }),
    );
  });
});

describe('config lock (LC-02)', () => {
  it('allows config changes only while ready', () => {
    expect(() => assertConfigMutable(match('ready'))).not.toThrow();
    expect(() => assertConfigMutable(match('live'))).toThrow(
      expect.objectContaining({ code: 'CONFIG_LOCKED' }),
    );
    expect(() => assertConfigMutable(match('finished'))).toThrow(LifecycleError);
    expect(() => assertConfigMutable(match('cancelled'))).toThrow(LifecycleError);
  });
});

describe('operational action gate', () => {
  it('allows operational actions on a live match', () => {
    expect(() =>
      assertOperationalActionAllowed(match('live'), dispatchAction('score.change')),
    ).not.toThrow();
  });

  it('rejects operational actions on ready and cancelled matches', () => {
    expect(() =>
      assertOperationalActionAllowed(match('ready'), dispatchAction('clock.start')),
    ).toThrow(expect.objectContaining({ code: 'OPERATIONAL_NOT_ALLOWED' }));
    expect(() =>
      assertOperationalActionAllowed(match('cancelled'), dispatchAction('score.change')),
    ).toThrow(expect.objectContaining({ code: 'MATCH_CANCELLED' }));
  });

  it('only allows undo on a finished, undecided match', () => {
    expect(() =>
      assertOperationalActionAllowed(match('finished', 'undecided'), dispatchAction('match.undo')),
    ).not.toThrow();
    expect(() =>
      assertOperationalActionAllowed(
        match('finished', 'undecided'),
        dispatchAction('score.change'),
      ),
    ).toThrow(LifecycleError);
    expect(() =>
      assertOperationalActionAllowed(match('finished', 'saved'), dispatchAction('match.undo')),
    ).toThrow(LifecycleError);
  });
});
