import { describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { SocketIoGateway } from '../../src/realtime/adapters.js';
import { matchRoom, roleRoom } from '../../src/realtime/gateway.js';

interface Emitted {
  room: string;
  event: string;
  payload: unknown;
}

interface Disconnected {
  room: string;
  close: boolean;
}

function createFakeIo() {
  const emitted: Emitted[] = [];
  const joins: Array<{ socket: string; room: string }> = [];
  const leaves: Array<{ socket: string; room: string }> = [];
  const disconnected: Disconnected[] = [];
  const sockets = new Map<
    string,
    { join: (room: string) => void; leave: (room: string) => void }
  >();

  const io = {
    sockets: {
      sockets: {
        get: (id: string) => sockets.get(id),
      },
    },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
      },
    }),
    in: (room: string) => ({
      disconnectSockets: (close: boolean) => {
        disconnected.push({ room, close });
      },
    }),
  } as unknown as Server;

  return {
    io,
    emitted,
    joins,
    leaves,
    disconnected,
    registerSocket(id: string) {
      sockets.set(id, {
        join: (room) => joins.push({ socket: id, room }),
        leave: (room) => leaves.push({ socket: id, room }),
      });
    },
  };
}

describe('SocketIoGateway', () => {
  it('joins and leaves the match room and the role room', () => {
    const fake = createFakeIo();
    fake.registerSocket('s1');
    const gateway = new SocketIoGateway(fake.io);

    gateway.join('m1', 's1', 'operator');

    expect(fake.joins).toEqual([
      { socket: 's1', room: matchRoom('m1') },
      { socket: 's1', room: roleRoom('m1', 'operator') },
    ]);

    gateway.leave('m1', 's1');
    expect(fake.leaves.map((item) => item.room)).toEqual([
      matchRoom('m1'),
      roleRoom('m1', 'operator'),
      roleRoom('m1', 'viewer'),
    ]);
  });

  it('broadcasts role-scoped patches and all-room clock/status', () => {
    const fake = createFakeIo();
    const gateway = new SocketIoGateway(fake.io);

    gateway.broadcastPatch('m1', { version: 2 }, 'operator');
    gateway.broadcastPatch('m1', { version: 2 }, 'viewer');
    gateway.broadcastPatch('m1', { version: 2 }, 'all');
    gateway.broadcastClock('m1', { serverTs: 1 });
    gateway.broadcastStatus('m1', { matchStatus: 'live' });

    expect(fake.emitted.map((item) => [item.room, item.event])).toEqual([
      [roleRoom('m1', 'operator'), 'match:patch'],
      [roleRoom('m1', 'viewer'), 'match:patch'],
      [matchRoom('m1'), 'match:patch'],
      [matchRoom('m1'), 'match:clock'],
      [matchRoom('m1'), 'match:status'],
    ]);
  });

  it('emits private messages and disconnects a role room', () => {
    const fake = createFakeIo();
    const gateway = new SocketIoGateway(fake.io);

    gateway.emitTo('s1', 'operator:session', { sessionId: 'x' });
    gateway.disconnectRole('m1', 'viewer');

    expect(fake.emitted).toEqual([
      { room: 's1', event: 'operator:session', payload: { sessionId: 'x' } },
    ]);
    expect(fake.disconnected).toEqual([{ room: roleRoom('m1', 'viewer'), close: true }]);
  });
});
