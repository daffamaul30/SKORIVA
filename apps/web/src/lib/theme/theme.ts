/**
 * Theme configuration (T-31.8).
 *
 * B-12 requires Light/Dark everywhere, defaulting to the device preference.
 * Persistence for anonymous users uses `localStorage` via `next-themes`.
 *
 * Backend gap: there is **no** account theme-preference endpoint or field, so a
 * logged-in preference is not synchronised. Do not claim otherwise.
 */

export const THEME_STORAGE_KEY = 'skoriva-theme';

export const THEME_NAMES = ['light', 'dark', 'system'] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/** Values shared by the provider and its tests. */
export const THEME_PROVIDER_PROPS = {
  attribute: 'class',
  defaultTheme: 'system',
  enableSystem: true,
  storageKey: THEME_STORAGE_KEY,
  disableTransitionOnChange: true,
} as const;
