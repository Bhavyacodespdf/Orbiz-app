import type { Database } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  notify,
  notifyOutletStaff,
  dispatchPending,
} from '../notifications/notifications.service.js';
import { orderNotice } from '../notifications/order-notices.js';
import { recalculateOutlet } from '../kitchen/kitchen.service.js';
import { ALMOST_READY_MINUTES, DELAY_MINUTES } from '../kitchen/kitchen.rules.js';
import { pickupDeadline } from '../noshow/noshow.rules.js';
import { autoAcceptSweep } from '../autoaccept/autoaccept.service.js';

/*
 * Time-based alerts and housekeeping (docs/notifications.md, docs/kitchen-queue.md). All state is
 * in the database: each alert is a notification with a unique dedupe key, written in a
 * transaction that first re-checks the order is still eligible. So a restart, a missed tick or
 * several API instances running this at once can never send a logical alert twice or a stale one.
 */

/** Scheduled orders: remind the student this long before their pickup slot. */
export const SCHEDULED_REMINDER_MINUTES = 10;
/** Ready scheduled orders: warn this long before the no-show deadline. */
export const DEADLINE_WARNING_MINUTES = 5;
/** A manager alert when this many orders at an outlet are delayed at once. */
export const QUEUE_DELAY_ALERT_COUNT = 3;

const MINUTE_MS = 60_000;
const clock = (d: Date) =>
  d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

/** Recalculates every outlet with kitchen work (estimates drift as time passes). */
export async function recalcActiveOutlets(db: Database, realtime: RealtimePublisher, now: Date) {
  const outlets = await db.order.findMany({
    where: { status: { in: ['PLACED', 'ACCEPTED', 'PREPARING'] } },
    distinct: ['outletId'],
    select: { outletId: true },
  });
  // Outlets whose last orders just left the kitchen still need their estimates cleared.
  const stale = await db.orderEstimate.findMany({
    distinct: ['outletId'],
    select: { outletId: true },
  });
  const ids = [...new Set([...outlets, ...stale].map((o) => o.outletId))];
  for (const outletId of ids) {
    const changed = await recalculateOutlet(db, outletId, now);
    for (const c of changed) realtime.estimateUpdated(c.orderId, c.userId, outletId);
  }
  return ids.length;
}

/** "May be ready in about 2 minutes" — once, only while the order is really being prepared. */
export async function sendAlmostReady(db: Database, now: Date) {
  const due = await db.orderEstimate.findMany({
    where: {
      predictedReadyAt: { lte: new Date(now.getTime() + ALMOST_READY_MINUTES * MINUTE_MS) },
      order: { status: 'PREPARING' },
    },
    select: { orderId: true },
  });
  let sent = 0;
  for (const { orderId } of due) {
    sent += await db.$transaction(async (tx) => {
      // Re-check under a row lock: a READY/cancelled order gets no "almost ready".
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      if (row?.status !== 'PREPARING') return 0;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { outlet: { select: { name: true } } },
      });
      return notify(
        tx,
        orderNotice(
          {
            id: order.id,
            userId: order.userId,
            pickupCode: order.pickupCode,
            outletName: order.outlet.name,
          },
          'ORDER_ALMOST_READY',
          {
            title: `Order ${order.pickupCode} is almost ready`,
            body: `Your order may be ready in about ${ALMOST_READY_MINUTES} minutes (an estimate). Head to ${order.outlet.name}.`,
          },
          'ALMOST_READY',
        ),
      );
    });
  }
  return sent;
}

/**
 * Scheduled-order reminders, from the scheduled time itself (not the estimate): one before the
 * pickup slot, and — once ready — one before the no-show deadline. They never change the order;
 * the existing no-show worker alone decides no-shows.
 */
export async function sendScheduledReminders(db: Database, now: Date) {
  let sent = 0;
  const soon = await db.order.findMany({
    where: {
      timing: 'SCHEDULED',
      status: { in: ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'] },
      scheduledFor: {
        gt: now,
        lte: new Date(now.getTime() + SCHEDULED_REMINDER_MINUTES * MINUTE_MS),
      },
    },
    include: { outlet: { select: { name: true } } },
  });
  for (const o of soon) {
    sent += await notify(
      db,
      orderNotice(
        { id: o.id, userId: o.userId, pickupCode: o.pickupCode, outletName: o.outlet.name },
        'SCHEDULED_PICKUP_SOON',
        {
          title: `Pickup at ${clock(o.scheduledFor!)}`,
          body: `Your scheduled order ${o.pickupCode} is due at ${o.outlet.name} at ${clock(o.scheduledFor!)}.`,
        },
        'SCHEDULED_SOON',
      ),
    );
  }

  const ready = await db.order.findMany({
    where: { timing: 'SCHEDULED', status: 'READY', scheduledFor: { not: null } },
    include: { outlet: { select: { name: true } } },
  });
  for (const o of ready) {
    const deadline = pickupDeadline(o.scheduledFor!);
    const left = deadline.getTime() - now.getTime();
    if (left <= 0 || left > DEADLINE_WARNING_MINUTES * MINUTE_MS) continue;
    sent += await notify(
      db,
      orderNotice(
        { id: o.id, userId: o.userId, pickupCode: o.pickupCode, outletName: o.outlet.name },
        'PICKUP_DEADLINE_SOON',
        {
          title: `Collect ${o.pickupCode} by ${clock(deadline)}`,
          body: `Your order is waiting at ${o.outlet.name}. After ${clock(deadline)} the scheduled-order no-show policy applies.`,
        },
        'DEADLINE_SOON',
      ),
    );
  }
  return sent;
}

/** Staff hear once about an order running well past its estimate; managers about a backlog. */
export async function sendDelayAlerts(db: Database, now: Date) {
  const delayed = await db.orderEstimate.findMany({
    where: {
      predictedReadyAt: { lt: new Date(now.getTime() - DELAY_MINUTES * MINUTE_MS) },
      order: { status: 'PREPARING' },
    },
    include: { order: { select: { id: true, pickupCode: true, outletId: true } } },
  });
  let sent = 0;
  for (const e of delayed) {
    sent += await notifyOutletStaff(db, e.order.outletId, ['MANAGER', 'POS'], {
      type: 'STAFF_ORDER_DELAYED',
      title: `Order ${e.order.pickupCode} is running late`,
      body: `It was estimated ready by ${clock(e.predictedReadyAt)}. Check on it or update the student.`,
      link: '/pos',
      entityType: 'Order',
      entityId: e.order.id,
      dedupeKey: `order:${e.order.id}:DELAYED`,
    });
  }
  const perOutlet = new Map<string, number>();
  for (const e of delayed)
    perOutlet.set(e.order.outletId, (perOutlet.get(e.order.outletId) ?? 0) + 1);
  const hour = now.toISOString().slice(0, 13);
  for (const [outletId, count] of perOutlet) {
    if (count < QUEUE_DELAY_ALERT_COUNT) continue;
    sent += await notifyOutletStaff(db, outletId, ['MANAGER'], {
      type: 'MANAGER_QUEUE_DELAYS',
      title: `${count} orders are running late`,
      body: 'The queue is behind its estimates. Consider more kitchen capacity or pausing new orders.',
      link: '/manage',
      dedupeKey: `outlet:${outletId}:QUEUE_DELAYS:${hour}`,
    });
  }
  return sent;
}

/** One pass of every job. Each step is isolated: one failing never stops the others. */
export async function runOperations(db: Database, realtime: RealtimePublisher, now = new Date()) {
  const steps: [string, () => Promise<unknown>][] = [
    ['auto-accept', () => autoAcceptSweep(db, realtime, now)],
    ['queue recalculation', () => recalcActiveOutlets(db, realtime, now)],
    ['almost-ready alerts', () => sendAlmostReady(db, now)],
    ['scheduled reminders', () => sendScheduledReminders(db, now)],
    ['delay alerts', () => sendDelayAlerts(db, now)],
    ['notification delivery', () => dispatchPending(db, realtime)],
  ];
  const results: Record<string, unknown> = {};
  for (const [name, run] of steps) {
    try {
      results[name] = await run();
    } catch (err) {
      results[name] = 'failed';
      logger.error({ err, step: name }, 'Operations step failed');
    }
  }
  return results;
}
