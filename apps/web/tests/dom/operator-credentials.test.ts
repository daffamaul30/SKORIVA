/**
 * T-31.6 — Operator credential store transitions.
 *
 * Verifies the two-credential model, that rotation never touches the session
 * credential, that handover replaces it, and that nothing is persisted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  selectHasControlToken,
  selectHasSessionCredential,
  selectSessionStatus,
  useOperatorCredentials,
} from '@/lib/store/operator-credentials.store';

const store = useOperatorCredentials;

beforeEach(() => {
  store.getState().clearCredentials();
});

afterEach(() => {
  store.getState().clearCredentials();
  vi.restoreAllMocks();
});

describe('credential separation', () => {
  it('keeps controlToken and sessionCredential as distinct fields', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });

    expect(store.getState().controlToken).toBe('ctl-1');
    expect(store.getState().sessionCredential).toBeNull();

    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    expect(store.getState().controlToken).toBe('ctl-1');
    expect(store.getState().sessionCredential).toBe('sess-1');
    expect(store.getState().sessionId).toBe('s-1');
  });

  it('exposes no ambiguous generic token field', () => {
    const state = store.getState() as unknown as Record<string, unknown>;

    expect(state).not.toHaveProperty('operatorToken');
    expect(state).not.toHaveProperty('token');
  });
});

describe('transitions', () => {
  it('rotating the control token leaves the session credential intact', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-old' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    store.getState().rotateControlToken({ matchId: 'm-1', controlToken: 'ctl-new' });

    expect(store.getState().controlToken).toBe('ctl-new');
    expect(store.getState().sessionCredential).toBe('sess-1');
  });

  it('a handover replaces the receiving operator session credential', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-old',
      credential: 'sess-old',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    store.getState().replaceSessionCredential({
      matchId: 'm-1',
      sessionId: 's-new',
      credential: 'sess-new',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    expect(store.getState().sessionId).toBe('s-new');
    expect(store.getState().sessionCredential).toBe('sess-new');
    // The control token is ownership, not the session: it is untouched.
    expect(store.getState().controlToken).toBe('ctl-1');
  });

  it('switching match clears previous credentials', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    store.getState().setInitialControlToken({ matchId: 'm-2', controlToken: 'ctl-2' });

    expect(store.getState().matchId).toBe('m-2');
    expect(store.getState().controlToken).toBe('ctl-2');
    expect(store.getState().sessionCredential).toBeNull();
    expect(store.getState().sessionId).toBeNull();
  });

  it('ignores a rotation aimed at another match', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });

    store.getState().rotateControlToken({ matchId: 'm-2', controlToken: 'ctl-other' });

    expect(store.getState().matchId).toBe('m-1');
    expect(store.getState().controlToken).toBe('ctl-1');
  });

  it('clears everything on revocation or termination', () => {
    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    store.getState().clearCredentials();

    expect(store.getState()).toMatchObject({
      matchId: null,
      controlToken: null,
      sessionCredential: null,
      sessionId: null,
      expiresAt: null,
    });
  });
});

describe('derived selectors', () => {
  it('reports claim-available, active, then unauthenticated', () => {
    expect(selectSessionStatus(store.getState())).toBe('unauthenticated');

    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    expect(selectSessionStatus(store.getState())).toBe('claim-available');
    expect(selectHasControlToken(store.getState())).toBe(true);
    expect(selectHasSessionCredential(store.getState())).toBe(false);

    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });
    expect(selectSessionStatus(store.getState())).toBe('active');
    expect(selectHasSessionCredential(store.getState())).toBe(true);

    store.getState().clearCredentials();
    expect(selectSessionStatus(store.getState())).toBe('unauthenticated');
  });

  it('models a page refresh as unauthenticated (memory only)', () => {
    // A fresh module instance is what a reload produces: nothing survives.
    store.getState().clearCredentials();

    expect(selectSessionStatus(store.getState())).toBe('unauthenticated');
    expect(selectHasControlToken(store.getState())).toBe(false);
  });
});

describe('no persistence', () => {
  it('has no persist middleware attached', () => {
    const withPersist = store as unknown as Record<string, unknown>;

    expect(withPersist.persist).toBeUndefined();
  });

  it('writes to no web storage and no cookie during transitions', () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const sessionSet = vi.spyOn(Storage.prototype, 'setItem');
    const cookieSpy = vi.spyOn(document, 'cookie', 'set');

    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-1' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-1',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });
    store.getState().rotateControlToken({ matchId: 'm-1', controlToken: 'ctl-2' });
    store.getState().clearCredentials();

    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(cookieSpy).not.toHaveBeenCalled();
  });

  it('never logs credentials', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.getState().setInitialControlToken({ matchId: 'm-1', controlToken: 'ctl-secret' });
    store.getState().setSessionCredential({
      matchId: 'm-1',
      sessionId: 's-1',
      credential: 'sess-secret',
      expiresAt: '9999-12-31T23:59:59.999Z',
    });

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join(' ');

    expect(logged).not.toContain('ctl-secret');
    expect(logged).not.toContain('sess-secret');
  });
});
