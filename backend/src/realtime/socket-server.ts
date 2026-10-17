import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { parseCookie } from 'cookie';
import type { Env } from '../config/env.js';
import type { Database } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveSession } from '../modules/auth/session.service.js';
import { sessionCookieName } from '../modules/auth/cookies.js';
import {
  orderEventPayload,
  pollEventPayload,
  rooms,
  type PollEventInput,
  type RealtimePublisher,
} from './publisher.js';

interface SocketData {
  userId: string;
  sessionId: string;
  token: string;
}

/** How often live connections re-check that their session is still valid (role revoked, expired, suspended). */
export const SESSION_RECHECK_MS = 60_000;
/** Minimum gap between vote-count hints for one poll. */
export const POLL_THROTTLE_MS = 1000;

/**
 * Authenticated Socket.IO server.
 *
 * - The handshake must come from our own frontend origin (blocks cross-site
 *   WebSocket hijacking) and carry a valid session cookie.
 * - The SERVER decides which rooms a socket joins. Clients cannot subscribe to
 *   anything: there is no "join room" event at all.
 *     user:{id}             — that user's orders and wallet
 *     outlet:{id}:staff     — only for staff currently holding the role AND assigned there
 */
export function createSocketServer(
  httpServer: HttpServer,
  db: Database,
  config: Env,
  options: { sessionRecheckMs?: number } = {},
) {
  const allowedOrigin = new URL(config.FRONTEND_URL).origin;
  const io = new Server<
    Record<string, never>,
    Record<string, (...args: unknown[]) => void>,
    Record<string, never>,
    SocketData
  >(httpServer, {
    path: '/socket.io',
    cors: { origin: allowedOrigin, credentials: true },
    serveClient: false,
  });
  const cookieName = sessionCookieName(config);

  io.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin;
      if (origin && origin !== allowedOrigin) return next(new Error('ORIGIN_NOT_ALLOWED'));
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const token = cookies[cookieName];
      if (!token) return next(new Error('UNAUTHENTICATED'));
      const session = await resolveSession(db, token);
      if (!session) return next(new Error('UNAUTHENTICATED'));
      socket.data = { userId: session.user.id, sessionId: session.sessionId, token };
      next();
    } catch (err) {
      logger.error({ err }, 'Socket handshake failed');
      next(new Error('SERVER_ERROR'));
    }
  });

  /**
   * Puts a socket in exactly the outlet rooms its user may hear about right
   * now: roles re-read from the database, assignments to active outlets only.
   */
  async function syncStaffRooms(socket: {
    data: SocketData;
    rooms: Set<string>;
    join: (rooms: string[]) => unknown;
    leave: (room: string) => unknown;
  }) {
    const session = await resolveSession(db, socket.data.token);
    const staffRoles = (session?.user.roles ?? []).filter((r) => r === 'MANAGER' || r === 'POS');
    const assignments =
      staffRoles.length === 0
        ? []
        : await db.staffAssignment.findMany({
            where: {
              userId: socket.data.userId,
              role: { in: staffRoles },
              outlet: { isActive: true },
            },
            select: { outletId: true },
          });
    const wanted = new Set(assignments.map((a) => rooms.outletStaff(a.outletId)));
    for (const room of [...socket.rooms]) {
      if (room.startsWith('outlet:') && !wanted.has(room)) await socket.leave(room);
    }
    await socket.join([...wanted]);
  }

  io.on('connection', async (socket) => {
    const { userId, sessionId } = socket.data;
    await socket.join([rooms.user(userId), rooms.session(sessionId)]);
    await syncStaffRooms(socket);
    socket.emit('ready', { rooms: [...socket.rooms].filter((r) => r !== socket.id).length });
  });

  // Sessions can be revoked from elsewhere (logout on another tab, role revocation via the CLI,
  // suspension). Periodically drop live connections whose session is no longer valid.
  const recheck = setInterval(async () => {
    try {
      for (const socket of await io.fetchSockets()) {
        const data = socket.data as SocketData;
        if (!(await resolveSession(db, data.token))) {
          socket.emit('session.revoked', {});
          socket.disconnect(true);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Socket session re-check failed');
    }
  }, options.sessionRecheckMs ?? SESSION_RECHECK_MS);
  recheck.unref();

  // Vote-count hints to staff: at most one per poll per second, always ending on the latest.
  const pollThrottle = new Map<string, { timer: NodeJS.Timeout; pending: PollEventInput | null }>();
  function emitToStaff(poll: PollEventInput) {
    io.to(rooms.outletStaff(poll.outletId)).emit('poll.updated', pollEventPayload(poll));
  }
  function throttledStaffEmit(poll: PollEventInput) {
    const entry = pollThrottle.get(poll.id);
    if (entry) {
      entry.pending = poll;
      return;
    }
    emitToStaff(poll);
    const timer = setTimeout(function flush() {
      const current = pollThrottle.get(poll.id);
      pollThrottle.delete(poll.id);
      if (current?.pending) emitToStaff(current.pending);
    }, POLL_THROTTLE_MS);
    timer.unref();
    pollThrottle.set(poll.id, { timer, pending: null });
  }

  const publisher: RealtimePublisher = {
    orderCreated(order, ownerId) {
      const payload = orderEventPayload(order);
      io.to(rooms.outletStaff(order.outlet.id)).emit('order.created', payload);
      io.to(rooms.user(ownerId)).emit('order.updated', payload);
    },
    orderUpdated(order, ownerId) {
      const payload = orderEventPayload(order);
      io.to([rooms.user(ownerId), rooms.outletStaff(order.outlet.id)]).emit(
        'order.updated',
        payload,
      );
    },
    orderReady(order, ownerId) {
      io.to(rooms.user(ownerId)).emit('order.ready', {
        orderId: order.id,
        pickupCode: order.pickupCode,
        outletName: order.outlet.name,
      });
    },
    notificationCreated(userId, notification) {
      io.to(rooms.user(userId)).emit('notification.created', notification);
    },
    estimateUpdated(orderId, ownerId, outletId) {
      io.to([rooms.user(ownerId), rooms.outletStaff(outletId)]).emit('estimate.updated', {
        orderId,
        outletId,
      });
    },
    walletUpdated(userId, reason) {
      io.to(rooms.user(userId)).emit('wallet.updated', { reason });
    },
    endSession(sessionId) {
      io.to(rooms.session(sessionId)).emit('session.revoked', {});
      io.in(rooms.session(sessionId)).disconnectSockets(true);
    },
    endUser(userId) {
      io.to(rooms.user(userId)).emit('session.revoked', {});
      io.in(rooms.user(userId)).disconnectSockets(true);
    },
    socialChanged(userIds, change, outletId) {
      const targets = [...new Set(userIds)].map((id) => rooms.user(id));
      if (outletId) targets.push(rooms.outletStaff(outletId));
      if (targets.length > 0) io.to(targets).emit('social.updated', change);
    },
    stockChanged(outletId, menuItemIds) {
      if (menuItemIds.length > 0) io.emit('stock.updated', { outletId, menuItemIds });
    },
    pollUpdated(poll, change) {
      if (change === 'status') io.emit('poll.updated', pollEventPayload(poll));
      else throttledStaffEmit(poll);
    },
    staffAccessChanged(userId) {
      void (async () => {
        try {
          for (const socket of await io.in(rooms.user(userId)).fetchSockets()) {
            await syncStaffRooms({
              data: socket.data as SocketData,
              rooms: socket.rooms,
              join: (r) => socket.join(r),
              leave: (r) => socket.leave(r),
            });
            socket.emit('access.changed', {});
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to refresh socket rooms');
        }
      })();
    },
  };

  return {
    io,
    publisher,
    async close() {
      clearInterval(recheck);
      for (const { timer } of pollThrottle.values()) clearTimeout(timer);
      pollThrottle.clear();
      await io.close();
    },
  };
}
