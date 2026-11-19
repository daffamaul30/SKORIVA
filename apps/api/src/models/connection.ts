/**
 * MongoDB connection helper (T-06).
 *
 * Responsibilities:
 * - fail fast when `MONGODB_URI` is missing or invalid;
 * - connect with a bounded number of attempts and exponential backoff;
 * - never log credentials or the connection string;
 * - expose an injectable `ConnectionAdapter` so logic can be unit-tested
 *   without a running MongoDB instance.
 *
 * The Mongoose connection is process-wide (single backend instance, NFR-17).
 */

import mongoose from 'mongoose';

export interface ConnectionAdapter {
  connect(uri: string, options?: mongoose.ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  readyState(): number;
  sleep(ms: number): Promise<void>;
}

export interface ConnectDatabaseOptions {
  adapter?: Partial<ConnectionAdapter>;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  serverSelectionTimeoutMS?: number;
}

export interface DisconnectDatabaseOptions {
  adapter?: Partial<ConnectionAdapter>;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  serverSelectionTimeoutMS: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  serverSelectionTimeoutMS: 5000,
};

/** `1` is Mongoose's `connected` ready state. */
export const MONGOOSE_CONNECTED = 1;
/** `0` is Mongoose's `disconnected` ready state. */
export const MONGOOSE_DISCONNECTED = 0;

const defaultAdapter: ConnectionAdapter = {
  connect: async (uri, options) => {
    await mongoose.connect(uri, options);
  },
  disconnect: async () => {
    await mongoose.disconnect();
  },
  readyState: () => mongoose.connection.readyState,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isMongoUri(uri: string): boolean {
  return uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://');
}

/**
 * Connect to MongoDB with bounded retries. Throws a clear error when the URI
 * is missing, invalid, or every attempt fails.
 */
export async function connectDatabase(
  uri: string,
  options: ConnectDatabaseOptions = {},
): Promise<void> {
  const trimmedUri = uri.trim();

  if (trimmedUri.length === 0) {
    throw new Error('MONGODB_URI is required.');
  }
  if (!isMongoUri(trimmedUri)) {
    throw new Error(
      'MONGODB_URI must be a MongoDB connection string (mongodb:// or mongodb+srv://).',
    );
  }

  const adapter: ConnectionAdapter = { ...defaultAdapter, ...options.adapter };
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const serverSelectionTimeoutMS =
    options.serverSelectionTimeoutMS ?? DEFAULT_RETRY.serverSelectionTimeoutMS;

  if (adapter.readyState() === MONGOOSE_CONNECTED) {
    return;
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const isFirstAttempt = attempt === 1;
      if (isFirstAttempt) {
        console.info('[skoriva-api] connecting to MongoDB');
      } else {
        console.info(`[skoriva-api] connecting to MongoDB (attempt ${attempt}/${maxAttempts})`);
      }

      await adapter.connect(trimmedUri, { serverSelectionTimeoutMS });

      console.info('[skoriva-api] connected to MongoDB');
      return;
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
        console.warn(
          `[skoriva-api] MongoDB connection attempt ${attempt} failed; retrying in ${delayMs}ms`,
        );
        await adapter.sleep(delayMs);
      }
    }
  }

  throw new Error(`Unable to connect to MongoDB after ${maxAttempts} attempts.`, {
    cause: lastError,
  });
}

/**
 * Close the Mongo connection. No-op when already disconnected.
 */
export async function disconnectDatabase(options: DisconnectDatabaseOptions = {}): Promise<void> {
  const adapter: ConnectionAdapter = { ...defaultAdapter, ...options.adapter };

  if (adapter.readyState() === MONGOOSE_DISCONNECTED) {
    return;
  }

  console.info('[skoriva-api] closing MongoDB connection');
  await adapter.disconnect();
}

/** Current Mongoose ready state (0 disconnected, 1 connected, 2 connecting, 3 disconnecting). */
export function getDatabaseState(): number {
  return mongoose.connection.readyState;
}
