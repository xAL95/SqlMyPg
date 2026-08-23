import type { FastifyPluginAsync } from 'fastify';
// re-exported by the plugin, so this needs no @types/ws entry of its own
import type { WebSocket } from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@shared/protocol.js';
import { requireUser } from './auth/plugin.js';
import { listSessions, sessionEvents, toState } from './session/manager.js';

const sockets = new Map<string, Set<WebSocket>>();
const missedPongs = new WeakMap<WebSocket, number>();
const PONG = JSON.stringify({ type: 'pong' } satisfies ServerMessage);

export const wsRoutes: FastifyPluginAsync = async (app) => {
  const onEvent = ({ userId, message }: { userId: string; message: ServerMessage }) => {
    const set = sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState !== ws.OPEN) set.delete(ws);
      else ws.send(data);
    }
    if (set.size === 0) sockets.delete(userId);
  };
  sessionEvents.on('event', onEvent);

  const beat = setInterval(() => {
    for (const [userId, set] of sockets) {
      for (const ws of set) {
        if (ws.readyState !== ws.OPEN || (missedPongs.get(ws) ?? 0) >= 2) {
          set.delete(ws);
          ws.terminate();
          continue;
        }
        missedPongs.set(ws, (missedPongs.get(ws) ?? 0) + 1);
        ws.ping();
      }
      if (set.size === 0) sockets.delete(userId);
    }
  }, 30_000);
  beat.unref();

  app.addHook('onClose', async () => {
    clearInterval(beat);
    sessionEvents.off('event', onEvent);
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = (() => {
      try {
        return requireUser(req);
      } catch {
        return null;
      }
    })();
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }

    let set = sockets.get(user.id);
    if (!set) {
      set = new Set();
      sockets.set(user.id, set);
    }
    set.add(socket);
    missedPongs.set(socket, 0);

    socket.send(JSON.stringify({ type: 'hello', sessions: listSessions(user.id).map(toState) } satisfies ServerMessage));

    socket.on('pong', () => missedPongs.set(socket, 0));

    socket.on('message', (raw: unknown) => {
      let msg: Partial<ClientMessage> | null = null;
      try {
        msg = JSON.parse(String(raw)) as Partial<ClientMessage>;
      } catch {
        return; // junk frame, ignore
      }
      // ponytail: subscribe/unsubscribe are accepted and ignored - every event for a user is fanned
      // out to all of that user's sockets; per-session filtering is the upgrade once someone keeps
      // dozens of tabs open on one account and the idle traffic starts to matter.
      if (msg?.type === 'ping') socket.send(PONG);
    });

    socket.on('error', () => socket.terminate());

    socket.on('close', () => {
      const mine = sockets.get(user.id);
      if (!mine) return;
      mine.delete(socket);
      if (mine.size === 0) sockets.delete(user.id);
    });
  });
};
