/**
 * T-31.1 same-origin proxy tests.
 *
 * `next.config.ts` is imported for real, so the assertions cover the actual
 * rewrite table Next.js consumes — not a text copy of it. `BACKEND_URL` is set
 * before evaluation because the config validates it at module load.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

async function loadRewrites(backendUrl: string | undefined) {
  vi.resetModules();
  if (backendUrl === undefined) {
    delete process.env.BACKEND_URL;
  } else {
    process.env.BACKEND_URL = backendUrl;
  }

  const config = (await import('../next.config')).default;
  // `rewrites` is a supported function form: it returns the rule table.
  const rewrites = config.rewrites;

  if (typeof rewrites !== 'function') {
    throw new Error('next.config.ts must expose a rewrites() function');
  }

  const result = await rewrites();

  // Next.js also allows the `{ beforeFiles, afterFiles, fallback }` shape; this
  // project uses the simple array form, and the tests assert exactly that.
  if (!Array.isArray(result)) {
    throw new Error('next.config.ts rewrites() must return a flat Rewrite[] array');
  }

  return result as readonly { source: string; destination: string }[];
}

const originalBackendUrl = process.env.BACKEND_URL;

beforeEach(() => {
  process.env.BACKEND_URL = 'http://localhost:4000';
});

afterEach(() => {
  if (originalBackendUrl === undefined) {
    delete process.env.BACKEND_URL;
  } else {
    process.env.BACKEND_URL = originalBackendUrl;
  }
  vi.resetModules();
});

describe('REST proxy rewrites', () => {
  it('maps every /api/* path to the backend without changing the path', async () => {
    const rules = await loadRewrites('http://localhost:4000');

    expect(rules).toStrictEqual([
      {
        source: '/api/:path*',
        destination: 'http://localhost:4000/api/:path*',
      },
    ]);
  });

  it('keeps the /api prefix exactly once (no stripping, no duplication)', async () => {
    const rules = await loadRewrites('http://localhost:4000');
    const [rule] = rules;

    expect(rule?.source).toBe('/api/:path*');
    expect(rule?.destination).toBe('http://localhost:4000/api/:path*');
    // The captured remainder is forwarded as-is, e.g.
    // /api/matches/123/events  ->  http://localhost:4000/api/matches/123/events
    expect(rule?.destination.replace(':path*', 'matches/123/events')).toBe(
      'http://localhost:4000/api/matches/123/events',
    );
  });

  it('does not normalise away a backend URL trailing slash into a double slash', async () => {
    const rules = await loadRewrites('http://localhost:4000/');

    expect(rules[0]?.destination).toBe('http://localhost:4000/api/:path*');
    expect(rules[0]?.destination).not.toContain('//api');
  });

  it('fails fast when BACKEND_URL is missing', async () => {
    await expect(loadRewrites(undefined)).rejects.toThrowError(
      'Invalid environment variable BACKEND_URL: must be provided.',
    );
  });

  it('never proxies other application paths', async () => {
    const rules = await loadRewrites('http://localhost:4000');

    expect(rules).toHaveLength(1);
    for (const rule of rules) {
      expect(rule.source.startsWith('/api/')).toBe(true);
    }
  });
});

describe('server/client bundle separation', () => {
  it('exposes BACKEND_URL only on the server config, never as NEXT_PUBLIC_', () => {
    const configSource = readFileSync(`${webRoot}/next.config.ts`, 'utf8');
    const envSource = readFileSync(`${webRoot}/src/lib/env.ts`, 'utf8');
    const exampleSource = readFileSync(`${webRoot}/.env.example`, 'utf8');

    for (const source of [configSource, envSource, exampleSource]) {
      expect(source).not.toContain('NEXT_PUBLIC_BACKEND_URL');
      expect(source).not.toContain('NEXT_PUBLIC_API_URL');
    }

    // The backend origin is read from a non-public server variable only.
    expect(envSource).toContain('source.BACKEND_URL');
    expect(envSource).toMatch(/process\.env\.NEXT_PUBLIC_SOCKET_URL/);
  });

  it('documents only public-safe values in the web env example', () => {
    const exampleSource = readFileSync(`${webRoot}/.env.example`, 'utf8');
    const entries = [...exampleSource.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((match) => ({
      key: match[1],
      value: (match[2] ?? '').trim(),
    }));

    // Exactly two variables are declared, and only one is browser-visible.
    expect(entries.map((entry) => entry.key)).toStrictEqual([
      'BACKEND_URL',
      'NEXT_PUBLIC_SOCKET_URL',
    ]);

    // No backend secret is declared as an actual variable in this file.
    const declaredKeys = new Set(entries.map((entry) => entry.key));
    for (const forbidden of ['MONGODB_URI', 'JWT_SECRET', 'TOKEN_PEPPER']) {
      expect(declaredKeys.has(forbidden)).toBe(false);
    }

    // Every value is a plain placeholder origin, never a real secret.
    for (const entry of entries) {
      expect(entry.value).toMatch(/^https?:\/\/[^\s]+$/);
      expect(entry.value.toLowerCase()).not.toContain('secret');
      expect(entry.value.toLowerCase()).not.toContain('password');
    }

    // The server-only variable must not carry the public prefix.
    expect(declaredKeys.has('NEXT_PUBLIC_BACKEND_URL')).toBe(false);
  });
});
