/**
 * FE-G2 design-token guards (UI/UX Spec §6, §23, §26).
 *
 * These tests read the stylesheet as text so they stay independent of CSS
 * refactors and Tailwind internals. They assert *declarations* (a token is
 * defined inside a theme block), not line order.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const globalsCss = readFileSync(path.join(webRoot, 'src/app/globals.css'), 'utf8');
const buttonSource = readFileSync(
  path.join(webRoot, 'src/components/ui/button.tsx'),
  'utf8',
);

/** Returns the body of a top-level CSS block such as `:root { ... }`. */
function readBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `block "${selector}" must exist`).toBeGreaterThanOrEqual(0);

  const end = source.indexOf('}', start);
  return source.slice(start, end);
}

describe('design tokens', () => {
  it('defines primary-dark in the light theme with the spec value', () => {
    expect(readBlock(globalsCss, ':root')).toContain('--primary-dark: #1d4ed8;');
  });

  it('defines primary-dark in the dark theme with the spec value', () => {
    expect(readBlock(globalsCss, '.dark')).toContain('--primary-dark: #1d4ed8;');
  });

  it('maps primary-dark to a Tailwind utility inside @theme inline', () => {
    expect(readBlock(globalsCss, '@theme inline')).toContain(
      '--color-primary-dark: var(--primary-dark);',
    );
  });

  it('keeps the existing brand and semantic tokens mapped', () => {
    const theme = readBlock(globalsCss, '@theme inline');

    expect(theme).toContain('--color-primary: var(--primary);');
    expect(theme).toContain('--color-live: var(--live);');
    expect(theme).toContain('--color-warning: var(--warning);');
    expect(theme).toContain('--color-success: var(--success);');
  });

  it('uses the primary-dark token for the default button hover', () => {
    expect(buttonSource).toContain('hover:bg-primary-dark');
    expect(buttonSource).not.toContain('hover:bg-primary/90');
  });
});

describe('shadcn/ui components', () => {
  it('contains no hardcoded hex colors (UI/UX Spec §26 rule 12)', () => {
    const uiDir = path.join(webRoot, 'src/components/ui');
    const sources = readdirSync(uiDir)
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => ({ file, source: readFileSync(path.join(uiDir, file), 'utf8') }));
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;

    expect(sources.length).toBeGreaterThan(0);

    for (const { file, source } of sources) {
      expect(source.match(hexPattern), `${file} must not hardcode hex colors`).toBeNull();
    }
  });
});
