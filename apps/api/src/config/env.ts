/**
 * Backend environment configuration.
 *
 * Priority (highest first):
 * 1. system environment variables;
 * 2. `apps/api/.env`;
 * 3. repository-root `.env`.
 *
 * `process.loadEnvFile()` does not overwrite variables that are already set,
 * so loading the app file before the root file implements this priority.
 *
 * T-06 adds the MongoDB URI. Auth secrets are still owned by T-10.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const APP_DIR = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

function loadEnvFiles(): void {
  const candidates = [resolve(APP_DIR, '.env'), resolve(REPO_ROOT, '.env')];

  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}

loadEnvFiles();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  MONGODB_URI: z
    .string()
    .trim()
    .min(1, 'MONGODB_URI is required.')
    .refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'MONGODB_URI must be a MongoDB connection string (mongodb:// or mongodb+srv://).',
    ),
  TOKEN_PEPPER: z.string().min(32, 'TOKEN_PEPPER must be at least 32 characters.'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters.'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate an environment source. Exported separately so tests can
 * exercise invalid values without mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}

/** Validated process environment for the running server. */
export const env: Env = parseEnv(process.env);
