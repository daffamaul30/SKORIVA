/**
 * Socket.IO server bootstrap (T-04).
 *
 * No rooms, namespaces, or operational events are registered here. The
 * `RealtimeGateway` abstraction and handlers belong to T-24/T-28.
 */

import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Env } from '../config/env.js';

export interface SocketServerOptions {
  webOrigin: Env['WEB_ORIGIN'];
}

/**
 * Attach a Socket.IO server to an existing HTTP server.
 *
 * CORS mirrors the Express configuration and uses an explicit origin; wildcard
 * origins are not allowed because cookies/credentials may be used (T-10).
 */
export function createSocketServer(httpServer: HttpServer, options: SocketServerOptions): Server {
  return new Server(httpServer, {
    serveClient: false,
    cors: {
      origin: options.webOrigin,
      credentials: true,
    },
  });
}
