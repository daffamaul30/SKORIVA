/**
 * Factory for mocking `next/font/google` (FE-G4).
 *
 * Called only from tests that render the root layout. The real loader cannot
 * run outside the Next.js compiler, so the returned object mirrors the shape
 * `next/font` exposes to components (`className`, `variable`, `style`).
 */

import { vi } from 'vitest';

export interface MockNextFont {
  className: string;
  variable: string;
  style: { fontFamily: string };
}

export function createNextFontMock(fontFamily: string, cssVariable: string): MockNextFont {
  return {
    className: `font-${fontFamily}`,
    variable: cssVariable,
    style: { fontFamily },
  };
}

/** Registers the module mock; call it before importing the component under test. */
export function mockNextFontGoogle(fontFamily = 'inter', cssVariable = '--font-inter'): MockNextFont {
  const font = createNextFontMock(fontFamily, cssVariable);

  vi.doMock('next/font/google', () => ({
    Inter: () => font,
  }));

  return font;
}
