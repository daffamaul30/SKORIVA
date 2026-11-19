import { describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../../src/models/index.js';

const VALID_URI = 'mongodb://127.0.0.1:27017/skoriva_test';

describe('connectDatabase', () => {
  it('connects successfully on the first attempt', async () => {
    const connect = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    await connectDatabase(VALID_URI, {
      adapter: { connect, sleep, readyState: () => 0 },
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(VALID_URI, { serverSelectionTimeoutMS: 5000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with exponential backoff and then succeeds', async () => {
    const connect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);

    await connectDatabase(VALID_URI, {
      adapter: { connect, sleep, readyState: () => 0 },
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 1000,
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('stops after maxAttempts and throws a clear error', async () => {
    const connect = vi.fn(async () => {
      throw new Error('still down');
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      connectDatabase(VALID_URI, {
        adapter: { connect, sleep, readyState: () => 0 },
        maxAttempts: 2,
        initialDelayMs: 1,
      }),
    ).rejects.toThrow('Unable to connect to MongoDB after 2 attempts.');

    expect(connect).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing URI before connecting', async () => {
    const connect = vi.fn(async () => undefined);

    await expect(connectDatabase('   ', { adapter: { connect } })).rejects.toThrow(
      'MONGODB_URI is required.',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a non-MongoDB URI before connecting', async () => {
    const connect = vi.fn(async () => undefined);

    await expect(
      connectDatabase('https://example.com/db', { adapter: { connect } }),
    ).rejects.toThrow('MONGODB_URI must be a MongoDB connection string');
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not reconnect when Mongoose is already connected', async () => {
    const connect = vi.fn(async () => undefined);

    await connectDatabase(VALID_URI, {
      adapter: { connect, readyState: () => 1 },
    });

    expect(connect).not.toHaveBeenCalled();
  });

  it('never logs the connection string or credentials', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secretUri = 'mongodb://user:super-secret-password@127.0.0.1:27017/skoriva_test';

    try {
      await connectDatabase(secretUri, {
        adapter: { connect: vi.fn(async () => undefined), readyState: () => 0 },
      });

      const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((value) => String(value))
        .join(' ');

      expect(logged).not.toContain('super-secret-password');
      expect(logged).not.toContain(secretUri);
      expect(logged).not.toContain('27017');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('disconnectDatabase', () => {
  it('disconnects when connected', async () => {
    const disconnect = vi.fn(async () => undefined);

    await disconnectDatabase({ adapter: { disconnect, readyState: () => 1 } });

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already disconnected', async () => {
    const disconnect = vi.fn(async () => undefined);

    await disconnectDatabase({ adapter: { disconnect, readyState: () => 0 } });

    expect(disconnect).not.toHaveBeenCalled();
  });
});
