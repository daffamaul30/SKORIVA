/**
 * SKORIVA API bootstrap.
 *
 * T-04: HTTP + Socket.IO bootstrap and graceful shutdown.
 * T-06: MongoDB is connected before the HTTP server starts accepting requests,
 *       and disconnected during shutdown.
 */

import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './models/index.js';
import { createSocketServer } from './realtime/socket.js';
import { setupRealtime } from './realtime/index.js';
import type { RealtimeRuntime } from './realtime/index.js';

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer, { webOrigin: env.WEB_ORIGIN });
let realtime: RealtimeRuntime | undefined;

const FORCE_SHUTDOWN_TIMEOUT_MS = 10_000;

httpServer.on('error', (error) => {
  console.error('[skoriva-api] server error', error);
  process.exit(1);
});

async function start(): Promise<void> {
  await connectDatabase(env.MONGODB_URI);
  realtime = setupRealtime(io);

  httpServer.listen(env.PORT, () => {
    console.info(`[skoriva-api] listening on http://localhost:${env.PORT} (env: ${env.NODE_ENV})`);
    console.info(`[skoriva-api] socket.io ready (origin: ${env.WEB_ORIGIN})`);
  });
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(`[skoriva-api] ${signal} received, shutting down`);

  const forceTimer = setTimeout(() => {
    console.error('[skoriva-api] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, FORCE_SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    realtime?.stop();

    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    await disconnectDatabase();

    clearTimeout(forceTimer);
    console.info('[skoriva-api] shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[skoriva-api] shutdown failed', error);
    process.exit(1);
  }
}

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});

process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

void start().catch((error: unknown) => {
  console.error('[skoriva-api] failed to start', error);
  process.exit(1);
});
