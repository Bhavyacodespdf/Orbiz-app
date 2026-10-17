import type { Database, DbClient } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { NotificationType, StaffRole } from '../../generated/prisma/enums.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';

/*
 * Persistent notifications (docs/notifications.md).
 *
 * Transactional outbox: business code calls notify() INSIDE its own transaction, so a
 * notification exists only if the change it describes committed. dispatchPending() then delivers
 * committed rows live over Socket.IO and records the outcome, with bounded retries. Socket.IO is
 * only a delivery channel; the inbox (this table) is the source of truth, so nothing is lost while
 * a user is offline. (userId, dedupeKey) is unique: repeated events create one notification.
 */

export const MAX_DELIVERY_ATTEMPTS = 5;
const CLAIM_LEASE_SECONDS = 30;
const PAGE_MAX = 50;

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  outletId?: string;
  /** The logical event, e.g. `order:<id>:READY`. One notification per user per key. */
  dedupeKey: string;
}

/** Records notifications in the caller's transaction. Duplicates (same user + key) are skipped. */
export async function notify(tx: DbClient, inputs: NotificationInput | NotificationInput[]) {
  const data = Array.isArray(inputs) ? inputs : [inputs];
  if (data.length === 0) return 0;
  const { count } = await tx.notification.createMany({ data, skipDuplicates: true });
  return count;
}

/** Staff currently holding one of `roles` AND assigned to the outlet with it. */
export async function outletStaff(tx: DbClient, outletId: string, roles: StaffRole[]) {
  const rows = await tx.staffAssignment.findMany({
    where: {
      outletId,
      role: { in: roles },
      outlet: { isActive: true },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true, role: true, user: { select: { roles: true } } },
  });
  return [
    ...new Set(
      rows
        .filter((r) => r.user.roles.some((ur) => ur.role === r.role && ur.revokedAt === null))
        .map((r) => r.userId),
    ),
  ];
}

/** One notification per assigned staff member (same dedupe key per person). */
export async function notifyOutletStaff(
  tx: DbClient,
  outletId: string,
  roles: StaffRole[],
  input: Omit<NotificationInput, 'userId' | 'outletId'>,
) {
  const users = await outletStaff(tx, outletId, roles);
  return notify(
    tx,
    users.map((userId) => ({ ...input, userId, outletId })),
  );
}

const backoffSeconds = (attempt: number) => Math.min(600, 15 * 2 ** Math.max(0, attempt - 1));

/**
 * Delivers committed, undelivered notifications live. Rows are claimed with
 * FOR UPDATE SKIP LOCKED and a short lease, so several API instances can run this at once and a
 * crash mid-delivery is simply retried after the lease. Delivery failures back off
 * exponentially (15 s, 30 s, … up to 10 min) and stop after MAX_DELIVERY_ATTEMPTS.
 */
export async function dispatchPending(db: Database, realtime: RealtimePublisher, limit = 200) {
  const claimed = await db.$queryRaw<
    { id: string; userId: string; type: NotificationType; deliveryAttempts: number }[]
  >`
    UPDATE "Notification"
    SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
        "deliveryAttempts" = "deliveryAttempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "Notification"
      WHERE "deliveryStatus" = 'PENDING'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= (now() AT TIME ZONE 'UTC'))
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "userId", "type", "deliveryAttempts"`;

  let delivered = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      realtime.notificationCreated(row.userId, { id: row.id, type: row.type });
      await db.notification.update({
        where: { id: row.id },
        data: { deliveryStatus: 'DELIVERED', deliveredAt: new Date(), lastError: null },
      });
      delivered += 1;
    } catch (err) {
      failed += 1;
      const final = row.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS;
      const message = err instanceof Error ? err.message.slice(0, 300) : 'Delivery failed';
      logger.warn(
        { notificationId: row.id, attempt: row.deliveryAttempts, final },
        'Notification delivery failed',
      );
      await db.notification.update({
        where: { id: row.id },
        data: {
          lastError: message,
          ...(final
            ? { deliveryStatus: 'FAILED', nextAttemptAt: null }
            : {
                nextAttemptAt: new Date(Date.now() + backoffSeconds(row.deliveryAttempts) * 1000),
              }),
        },
      });
      if (final) await reportDeliveryFailure(db, row.id).catch(() => undefined);
    }
  }
  return { delivered, failed };
}

/** A notification that could never be delivered live: tell the related outlet's managers (hourly). */
async function reportDeliveryFailure(db: Database, notificationId: string) {
  const n = await db.notification.findUniqueOrThrow({ where: { id: notificationId } });
  let outletId = n.outletId;
  if (!outletId && n.entityType === 'Order' && n.entityId) {
    outletId =
      (await db.order.findUnique({ where: { id: n.entityId }, select: { outletId: true } }))
        ?.outletId ?? null;
  }
  if (!outletId) return;
  const hour = new Date().toISOString().slice(0, 13);
  await notifyOutletStaff(db, outletId, ['MANAGER'], {
    type: 'MANAGER_DELIVERY_FAILURES',
    title: 'Live notifications are failing',
    body: 'Some notifications couldn’t be delivered live. They are still in each person’s inbox.',
    link: '/manage/kitchen',
    dedupeKey: `outlet:${outletId}:DELIVERY_FAILURES:${hour}`,
  });
}

// ─── Inbox API ───────────────────────────────────────────────────────────────

function toNotification(n: {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    entity: n.entityType && n.entityId ? { type: n.entityType, id: n.entityId } : null,
    read: n.readAt !== null,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

/** The user's own inbox, newest first, keyset-paged by (createdAt, id). */
export async function listNotifications(
  db: Database,
  userId: string,
  opts: { unreadOnly: boolean; limit: number; cursor?: string },
) {
  const limit = Math.min(opts.limit, PAGE_MAX);
  let after: { createdAt: Date; id: string } | null = null;
  if (opts.cursor) {
    const row = await db.notification.findFirst({
      where: { id: opts.cursor, userId },
      select: { createdAt: true, id: true },
    });
    after = row;
  }
  const rows = await db.notification.findMany({
    where: {
      userId,
      ...(opts.unreadOnly && { readAt: null }),
      ...(after && {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const unread = await db.notification.count({ where: { userId, readAt: null } });
  return {
    notifications: page.map(toNotification),
    unread,
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function markRead(db: Database, userId: string, id: string) {
  const { count } = await db.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0) {
    const exists = await db.notification.count({ where: { id, userId } });
    if (!exists) throw notFound('Notification not found');
  }
}

export async function markAllRead(db: Database, userId: string) {
  const { count } = await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export const unreadCount = (db: Database, userId: string) =>
  db.notification.count({ where: { userId, readAt: null } });
