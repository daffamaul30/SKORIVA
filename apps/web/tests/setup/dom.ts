/**
 * Shared test setup (FE-G4).
 *
 * Runs for every test file, so every DOM-only step is guarded by
 * `typeof window !== 'undefined'`. Node-environment tests are untouched.
 *
 * `console.error` is intentionally NOT silenced: React warnings and prop
 * validation failures must stay visible.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const isDom = typeof window !== 'undefined';

if (isDom) {
  await import('@testing-library/jest-dom/vitest');
  const { installBrowserPolyfills } = await import('./mocks/browser-apis');
  installBrowserPolyfills();
}

if (isDom) {
  afterEach(() => {
    cleanup();
  });
}
