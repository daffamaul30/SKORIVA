import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Node stays the default so server-render and file-reader tests keep
    // their original environment. Only `tests/dom/**` gets a real DOM.
    environment: 'node',
    environmentMatchGlobs: [['tests/dom/**', 'jsdom']],
    setupFiles: ['./tests/setup/dom.ts'],
  },
});
