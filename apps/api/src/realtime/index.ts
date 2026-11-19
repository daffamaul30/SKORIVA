/**
 * Realtime composition root (T-24…T-28).
 *
 * Wires the Socket.IO gateway, room manager, operational handlers, 1 Hz ticker,
 * shot-clock expiry, and the REST lifecycle publisher. The application boundary
 * calls this after MongoDB is connected.
 */

import type { Server } from 'socket.io';
import { env } from '../config/env.js';
import { runtimeRegistry } from '../core/runtime.registry.js';
import { setMatchChangePublisher } from '../modules/match/match.publisher.js';
import { SocketIoGateway } from './adapters.js';
import { registerRealtimeHandlers } from './handlers.js';
import { createMatchChangePublisher } from './match-publisher.js';
import { createRealtimeMatchService } from './match-service.js';
import { DEFAULT_GRACE_SWEEP_INTERVAL_MS, RoomManager } from './rooms.js';
import { createShotClockExpiry } from './shot-clock.js';
import { DEFAULT_TICK_INTERVAL_MS, MatchTicker } from './ticker.js';

export interface RealtimeSetupOptions {
  pepper?: string;
  graceSweepIntervalMs?: number;
  tickIntervalMs?: number;
  now?: () => Date;
}

export interface RealtimeRuntime {
  gateway: SocketIoGateway;
  rooms: RoomManager;
  ticker: MatchTicker;
  stop(): void;
}

export function setupRealtime(io: Server, options: RealtimeSetupOptions = {}): RealtimeRuntime {
  const now = options.now ?? (() => new Date());
  const pepper = options.pepper ?? env.TOKEN_PEPPER;
  const gateway = new SocketIoGateway(io);
  const rooms = new RoomManager({
    gateway,
    pepper,
    loadMatch: (matchId) => runtimeRegistry.loadMatch(matchId),
    now,
    graceSweepIntervalMs: options.graceSweepIntervalMs ?? DEFAULT_GRACE_SWEEP_INTERVAL_MS,
  });
  const matchService = createRealtimeMatchService();
  const ticker = new MatchTicker({
    registry: runtimeRegistry,
    gateway,
    intervalMs: options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    now,
    onShotClockExpired: createShotClockExpiry({ gateway, now }),
  });

  setMatchChangePublisher(createMatchChangePublisher(gateway));
  registerRealtimeHandlers(io, { gateway, rooms, matchService, pepper, now });
  rooms.startGraceSweeper();
  ticker.start();

  return {
    gateway,
    rooms,
    ticker,
    stop(): void {
      ticker.stop();
      rooms.stopGraceSweeper();
      setMatchChangePublisher(undefined);
    },
  };
}
