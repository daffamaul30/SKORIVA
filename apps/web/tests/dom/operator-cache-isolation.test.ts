/**
 * T-31 remediation R3 — automatic operator cache isolation.
 *
 * Proves every operator-session change path clears operator-scoped cache without
 * any component calling it, while public data survives.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installOperatorCacheIsolation,
  resolveIsolationTargets,
} from '@/features/match-session/operator-cache-isolation';
import { useMatchSession } from '@/features/match-session/store/match-session.store';
import { queryKeys } from '@/lib/query/query-keys';
import { useOperatorCredentials } from '@/lib/store/operator-credentials.store';

const credentials = useOperatorCredentials;
const session = useMatchSession;

const SESSION_EXPIRES = '9999-12-31T23:59:59.999Z';

function seed(client: QueryClient): void {
  client.setQueryData(queryKeys.matches.detail('m-1'), { id: 'm-1' });
  client.setQueryData(queryKeys.matches.events('m-1'), { events: [{ seq: 1 }] });
  client.setQueryData(queryKeys.matches.result('m-1'), { matchStatus: 'finished' });
  client.setQueryData(queryKeys.matches.detail('m-2'), { id: 'm-2' });
  client.setQueryData(queryKeys.events.list(), { events: [] });
  client.setQueryData(queryKeys.auth.session(), { id: 'acc-1' });
}

function expectPublicDataIntact(client: QueryClient): void {
  expect(client.getQueryData(queryKeys.matches.result('m-1'))).toBeDefined();
  expect(client.getQueryData(queryKeys.events.list())).toBeDefined();
  expect(client.getQueryData(queryKeys.auth.session())).toBeDefined();
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  credentials.getState().clearCredentials();
  session.getState().reset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  credentials.getState().clearCredentials();
  session.getState().reset();
});

describe('automatic installation', () => {
  it('clears operator cache when credentials are cleared', () => {
    const client = new QueryClient();
    dispose = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl' });
    credentials.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: SESSION_EXPIRES,
    });

    seed(client);

    credentials.getState().clearCredentials();

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    expectPublicDataIntact(client);
  });

  it('clears the previous and current match when the active match changes', () => {
    const client = new QueryClient();
    dispose = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    seed(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-2', controlToken: 'ctl-2' });

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.detail('m-2'))).toBeUndefined();
    expectPublicDataIntact(client);
  });

  it('clears cache when the operator session is replaced (handover)', () => {
    const client = new QueryClient();
    dispose = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl' });
    credentials.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-old',
      credential: 'sess-old',
      expiresAt: SESSION_EXPIRES,
    });

    seed(client);

    credentials.getState().replaceSessionCredential({
      matchId: 'm-1',
      sessionId: 's-new',
      credential: 'sess-new',
      expiresAt: SESSION_EXPIRES,
    });

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    expectPublicDataIntact(client);
  });

  it('clears cache when the operator loses operational rights', () => {
    const client = new QueryClient();
    dispose = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl' });
    credentials.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: SESSION_EXPIRES,
    });
    session.getState().startSession('m-1', 'operator');
    session.getState().setOperatorState({ active: true });

    seed(client);

    // `operator:state { active: false }` — another operator took over.
    session.getState().setOperatorState({ active: false });

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeUndefined();
    expectPublicDataIntact(client);
  });

  it('does not clear anything on unrelated session updates', () => {
    const client = new QueryClient();
    dispose = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl' });
    credentials.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: SESSION_EXPIRES,
    });
    session.getState().startSession('m-1', 'operator');
    session.getState().setOperatorState({ active: true });

    seed(client);

    // Clock, connection and snapshot churn must not evict operator data.
    session.getState().setConnection('reconnecting');
    session.getState().setConnection('connected');
    session.getState().applyClock({
      matchId: 'm-1',
      clock: { remainingMs: 1_000, isRunning: true, expired: false },
      serverTs: new Date().toISOString(),
    });

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeDefined();
    expect(client.getQueryData(queryKeys.matches.events('m-1'))).toBeDefined();
  });

  it('stops isolating after disposal', () => {
    const client = new QueryClient();
    const stop = installOperatorCacheIsolation(client);

    credentials.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl' });
    credentials.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: SESSION_EXPIRES,
    });

    seed(client);
    stop();

    credentials.getState().clearCredentials();

    expect(client.getQueryData(queryKeys.matches.detail('m-1'))).toBeDefined();
  });
});

describe('resolveIsolationTargets', () => {
  const base = {
    matchId: 'm-1',
    sessionId: 's-1',
    hasSessionCredential: true,
    operatorActive: true,
    role: 'operator',
  };

  it('returns nothing when nothing operator-scoped changed', () => {
    expect(resolveIsolationTargets(base, { ...base })).toStrictEqual([]);
  });

  it('returns both matches on a match change', () => {
    const targets = resolveIsolationTargets(base, { ...base, matchId: 'm-2' });
    expect(targets.sort()).toStrictEqual(['m-1', 'm-2']);
  });

  it('returns the current match when the session is replaced', () => {
    expect(resolveIsolationTargets(base, { ...base, sessionId: 's-2' })).toStrictEqual(['m-1']);
  });

  it('returns the previous match when credentials are cleared', () => {
    expect(
      resolveIsolationTargets(base, {
        ...base,
        matchId: null,
        sessionId: null,
        hasSessionCredential: false,
      }),
    ).toStrictEqual(['m-1']);
  });

  it('returns the match when operator rights are revoked', () => {
    expect(resolveIsolationTargets(base, { ...base, operatorActive: false })).toStrictEqual([
      'm-1',
    ]);
  });

  it('does not treat a first session as a replacement', () => {
    const beforeFirst = {
      ...base,
      sessionId: null,
      hasSessionCredential: false,
      operatorActive: false,
    };

    expect(resolveIsolationTargets(beforeFirst, base)).toStrictEqual([]);
  });
});
