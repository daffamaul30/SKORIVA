/**
 * Socket.IO adapter for `RealtimeGateway` (T-24).
 *
 * All payloads are role-scoped by the caller; this adapter only emits. It must
 * not read or compute match state.
 */

import type { Server } from 'socket.io';
import type { ClientRef, RealtimeGateway, RealtimeRole, RoleFilter } from './gateway.js';
import { matchRoom, roleRoom } from './gateway.js';

export class SocketIoGateway implements RealtimeGateway {
  constructor(private readonly io: Server) {}

  join(matchId: string, clientRef: ClientRef, role: RealtimeRole): void {
    const socket = this.io.sockets.sockets.get(clientRef);
    if (!socket) return;

    void socket.join(matchRoom(matchId));
    void socket.join(roleRoom(matchId, role));
  }

  leave(matchId: string, clientRef: ClientRef): void {
    const socket = this.io.sockets.sockets.get(clientRef);
    if (!socket) return;

    void socket.leave(matchRoom(matchId));
    void socket.leave(roleRoom(matchId, 'operator'));
    void socket.leave(roleRoom(matchId, 'viewer'));
  }

  disconnectRole(matchId: string, role: RealtimeRole): void {
    this.io.in(roleRoom(matchId, role)).disconnectSockets(true);
  }

  broadcastPatch(matchId: string, payload: unknown, roleFilter: RoleFilter): void {
    const room = roleFilter === 'all' ? matchRoom(matchId) : roleRoom(matchId, roleFilter);
    this.io.to(room).emit('match:patch', payload);
  }

  broadcastClock(matchId: string, payload: unknown): void {
    this.io.to(matchRoom(matchId)).emit('match:clock', payload);
  }

  broadcastStatus(matchId: string, payload: unknown): void {
    this.io.to(matchRoom(matchId)).emit('match:status', payload);
  }

  broadcastOperatorState(matchId: string, payload: unknown): void {
    this.io.to(matchRoom(matchId)).emit('operator:state', payload);
  }

  emitTo(clientRef: ClientRef, event: string, payload: unknown): void {
    this.io.to(clientRef).emit(event, payload);
  }
}
