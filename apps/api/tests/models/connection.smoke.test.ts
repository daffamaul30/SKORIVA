import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../../src/models/index.js';

/**
 * Real connect/disconnect smoke test against the MongoDB 7.0.14 binary used by
 * the MVP baseline. The first run downloads and caches the binary.
 */
describe('MongoDB connection smoke test', () => {
  let mongod: MongoMemoryServer | undefined;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      binary: { version: '7.0.14' },
    });
  });

  afterAll(async () => {
    await disconnectDatabase().catch(() => undefined);
    await mongod?.stop();
  });

  it('connects, reports connected state, and disconnects cleanly', async () => {
    if (!mongod) {
      throw new Error('MongoMemoryServer failed to start.');
    }

    const uri = mongod.getUri('skoriva_test');

    await connectDatabase(uri, { maxAttempts: 2 });
    expect(mongoose.connection.readyState).toBe(1);

    await disconnectDatabase();
    expect(mongoose.connection.readyState).toBe(0);
  });
});
