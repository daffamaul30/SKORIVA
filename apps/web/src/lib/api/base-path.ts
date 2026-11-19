/**
 * Same-origin API base path (T-31 remediation L3).
 *
 * Kept in its own module so client code can import it without pulling the
 * environment validator (and therefore `zod`) into the browser bundle.
 * `src/lib/env.ts` re-exports it for backwards compatibility.
 */

export const API_BASE_PATH = '/api' as const;
