import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repository-wide guardrails for `packages/shared/src` (Task T-02).
 *
 * Two rules make this scan trustworthy:
 * 1. Forbidden terms are assembled at runtime, so this file never contains the
 *    literal it searches for.
 * 2. Every `*.test.ts` file is skipped and comments are stripped before
 *    scanning, so a prohibition documented in a comment (e.g. "no timeout")
 *    cannot be mistaken for an actual declaration.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_TERMS: ReadonlyArray<{ label: string; term: string }> = [
  // Removed product concept: Event replaced it (PRD D-01, Tech Spec Open Decisions C).
  { label: 'removed grouping entity', term: 'Tour' + 'nament' },
  // Disabled for the whole MVP (B-03 / BR-21).
  { label: 'disabled feature', term: 'time' + 'out' },
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...listSourceFiles(absolute));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    files.push(absolute);
  }

  return files;
}

/** Remove `//` and `/* *\/` comments so only executable code is scanned. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

describe('forbidden terms in packages/shared/src', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('has source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { label, term } of FORBIDDEN_TERMS) {
    it(`does not declare the ${label} in code (${term.length} chars)`, () => {
      const offenders: string[] = [];

      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (code.toLowerCase().includes(term.toLowerCase())) {
          offenders.push(relative(SRC_ROOT, file));
        }
      }

      expect(offenders).toEqual([]);
    });
  }

  it('does not scan test files (no self-match possible)', () => {
    expect(files.every((file) => !file.endsWith('.test.ts'))).toBe(true);
  });

  it('strips comments before scanning', () => {
    expect(stripComments('// ' + 'time' + 'out\nconst a = 1;')).toBe('\nconst a = 1;');
  });
});
