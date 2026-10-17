/**
 * Real-time notifications. These are hints that "something changed — fetch
 * it again"; they are never the record. Every event is sent only AFTER the
 * database transaction that caused it has committed, and carries only IDs,
 * statuses and a version number — clients re-read details over REST.
 */

export interface OrderEventInput {
  id: string;
  outlet: { id: string };
  pickupCode: string;
  status: string;
  paymentStatus: string;
  version: number;
  placedAt: Date | string;
  updatedAt: Date | string;
}

export interface PollEventInput {
  id: string;
  outletId: string;
  status: string;
  version: number;
}

/**
 * 'status': a poll opened, closed, was finalized (or its schedule changed) — sent to
 *   every connected user, since Today's Special is public anyway.
 * 'staff': vote counts or a draft changed — sent only to the outlet's staff, throttled.
 * Payloads carry IDs, status and a version only: never votes or voters.
 */
export type PollChange = 'status' | 'staff';

export type WalletChangeReason = 'RECHARGE' | 'ORDER_DEBIT' | 'REFUND' | 'GROUP_SHARE' | 'TRANSFER';

/** Something in a group tray, peer split or banquet booking changed. */
export interface SocialChange {
  kind: 'GROUP' | 'SPLIT' | 'BANQUET';
  id: string;
}

export interface RealtimePublisher {
  /** A new order: tell the outlet's staff and the student who placed it. */
  orderCreated(order: OrderEventInput, ownerId: string): void;
  /** Status or payment changed: tell the owner and the outlet's staff. */
  orderUpdated(order: OrderEventInput, ownerId: string): void;
  /**
   * The order is ready for pickup: tell its owner (links to the order page). Carries the order
   * number and outlet only — never the pickup code or QR token.
   */
  orderReady(
    order: OrderEventInput & { outlet: { id: string; name: string } },
    ownerId: string,
  ): void;
  /**
   * A notification was committed to the user's inbox: tell their open tabs to refresh it.
   * Carries only the notification ID and type (the inbox API returns the content).
   */
  notificationCreated(userId: string, notification: { id: string; type: string }): void;
  /** Queue estimates for an order changed: its owner and the outlet's staff refresh. */
  estimateUpdated(orderId: string, ownerId: string, outletId: string): void;
  /** The owner's wallet balance or history changed. */
  walletUpdated(userId: string, reason: WalletChangeReason): void;
  /** End live connections for one session (logout). */
  endSession(sessionId: string): void;
  /** End every live connection of a user (role revoked by an admin). */
  endUser(userId: string): void;
  /** A user's roles or outlet assignments changed: recompute which outlet rooms they are in. */
  staffAccessChanged(userId: string): void;
  /** A Today's Special poll changed. */
  pollUpdated(poll: PollEventInput, change: PollChange): void;
  /**
   * Stock or availability of some menu items changed. Sent to everyone (menus are
   * public) with IDs only — never quantities; clients re-read what they show.
   */
  stockChanged(outletId: string, menuItemIds: string[]): void;
  /**
   * A group, split or banquet changed: tell the people involved (IDs only; clients re-read
   * what they're allowed to see) and, for banquets, the outlet's staff.
   */
  socialChanged(userIds: string[], change: SocialChange, outletId?: string): void;
}

/** Used when no socket server is running (most tests, scripts). */
export const noopPublisher: RealtimePublisher = {
  orderCreated() {},
  orderUpdated() {},
  orderReady() {},
  notificationCreated() {},
  estimateUpdated() {},
  walletUpdated() {},
  endSession() {},
  endUser() {},
  staffAccessChanged() {},
  pollUpdated() {},
  stockChanged() {},
  socialChanged() {},
};

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  outletStaff: (outletId: string) => `outlet:${outletId}:staff`,
  session: (sessionId: string) => `session:${sessionId}`,
};

export function orderEventPayload(order: OrderEventInput) {
  return {
    orderId: order.id,
    outletId: order.outlet.id,
    pickupCode: order.pickupCode,
    status: order.status,
    paymentStatus: order.paymentStatus,
    version: order.version,
    updatedAt: new Date(order.updatedAt).toISOString(),
  };
}

export function pollEventPayload(poll: PollEventInput) {
  return { pollId: poll.id, outletId: poll.outletId, status: poll.status, version: poll.version };
}

/**
 * A publisher that forwards to another one set later. Lets the Express app be
 * created first (it needs a publisher) and the socket server be attached to
 * the HTTP server afterwards (it needs the server).
 */
export function createDeferredPublisher() {
  let target: RealtimePublisher = noopPublisher;
  const publisher: RealtimePublisher = {
    orderCreated: (order, ownerId) => target.orderCreated(order, ownerId),
    orderUpdated: (order, ownerId) => target.orderUpdated(order, ownerId),
    orderReady: (order, ownerId) => target.orderReady(order, ownerId),
    notificationCreated: (userId, n) => target.notificationCreated(userId, n),
    estimateUpdated: (orderId, ownerId, outletId) =>
      target.estimateUpdated(orderId, ownerId, outletId),
    walletUpdated: (userId, reason) => target.walletUpdated(userId, reason),
    endSession: (sessionId) => target.endSession(sessionId),
    endUser: (userId) => target.endUser(userId),
    staffAccessChanged: (userId) => target.staffAccessChanged(userId),
    pollUpdated: (poll, change) => target.pollUpdated(poll, change),
    stockChanged: (outletId, menuItemIds) => target.stockChanged(outletId, menuItemIds),
    socialChanged: (userIds, change, outletId) => target.socialChanged(userIds, change, outletId),
  };
  return {
    publisher,
    connect(next: RealtimePublisher) {
      target = next;
    },
  };
}
