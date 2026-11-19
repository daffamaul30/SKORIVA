import { createServer } from 'node:http';
import { io as createClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSocketServer } from '../src/realtime/socket.js';

const WEB_ORIGIN = 'http://localhost:3000';

let client: Socket | undefined;

afterEach(() => {
  client?.close();
  client = undefined;
});

describe('Socket.IO bootstrap', () => {
  it('accepts a Socket.IO connection on the HTTP server', async () => {
    const httpServer = createServer(createApp());
    const io = createSocketServer(httpServer, { webOrigin: WEB_ORIGIN });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP address.');
      }

      client = createClient(`http://127.0.0.1:${address.port}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });

      await new Promise<void>((resolve, reject) => {
        client?.once('connect', resolve);
        client?.once('connect_error', reject);
      });

      expect(client.connected).toBe(true);
      expect(io.engine.clientsCount).toBe(1);
    } finally {
      client?.close();
      client = undefined;

      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    }
  });
});
