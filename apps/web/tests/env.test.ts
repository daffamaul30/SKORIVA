/**
 * T-31.1 environment validation tests.
 *
 * These exercise the schema functions directly with an explicit source object,
 * so they never depend on the developer's real environment.
 */

import { describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  backendUrlSchema,
  readBackendUrl,
  readSocketUrl,
  socketUrlSchema,
} from '@/lib/env';

describe('BACKEND_URL validation', () => {
  it('accepts an absolute http(s) URL', () => {
    expect(readBackendUrl({ BACKEND_URL: 'http://localhost:4000' })).toBe(
      'http://localhost:4000',
    );
    expect(readBackendUrl({ BACKEND_URL: 'https://api.example.com' })).toBe(
      'https://api.example.com',
    );
  });

  it('normalises trailing slashes so the proxy never builds a double slash', () => {
    expect(readBackendUrl({ BACKEND_URL: 'http://localhost:4000/' })).toBe(
      'http://localhost:4000',
    );
    expect(readBackendUrl({ BACKEND_URL: 'https://api.example.com///' })).toBe(
      'https://api.example.com',
    );
  });

  it('rejects a missing value with a message naming the variable', () => {
    expect(() => readBackendUrl({})).toThrowError(
      'Invalid environment variable BACKEND_URL: must be provided.',
    );
  });

  it('rejects relative paths and non-http protocols', () => {
    for (const value of ['localhost:4000', '/api', 'ws://localhost:4000', 'ftp://example.com']) {
      expect(() => backendUrlSchema.parse(value), value).toThrow();
    }
  });
});

describe('NEXT_PUBLIC_SOCKET_URL validation', () => {
  it('accepts an absolute http(s) URL', () => {
    expect(readSocketUrl({ NEXT_PUBLIC_SOCKET_URL: 'http://localhost:4000' })).toBe(
      'http://localhost:4000',
    );
  });

  it('rejects a missing or invalid value', () => {
    expect(() => readSocketUrl({})).toThrowError(
      'Invalid environment variable NEXT_PUBLIC_SOCKET_URL: must be provided.',
    );
    expect(() => readSocketUrl({ NEXT_PUBLIC_SOCKET_URL: 'not a url' })).toThrowError(
      /NEXT_PUBLIC_SOCKET_URL: must be an absolute http\(s\) URL\./,
    );
    expect(() => socketUrlSchema.parse('  ')).toThrow();
  });
});

describe('client/server separation', () => {
  it('exposes only the relative API base path to the browser', () => {
    expect(API_BASE_PATH).toBe('/api');
    expect(API_BASE_PATH.startsWith('/')).toBe(true);
    expect(API_BASE_PATH).not.toMatch(/^https?:/);
  });

  it('ignores any NEXT_PUBLIC_* value when resolving the server backend origin', () => {
    // Only `BACKEND_URL` may resolve the proxy target; a public variable can
    // never substitute for it, because none is read by the schema.
    const publicOnlySource = {
      NEXT_PUBLIC_API_URL: 'http://public-api.example.com',
      NEXT_PUBLIC_BACKEND_URL: 'http://public-backend.example.com',
      NEXT_PUBLIC_SOCKET_URL: 'http://localhost:4000',
    };

    expect(() => readBackendUrl(publicOnlySource)).toThrowError(/BACKEND_URL: must be provided/);

    const withServerValue = { ...publicOnlySource, BACKEND_URL: 'http://internal-api:4000' };
    expect(readBackendUrl(withServerValue)).toBe('http://internal-api:4000');
    expect(readSocketUrl(withServerValue)).toBe('http://localhost:4000');
  });
});
