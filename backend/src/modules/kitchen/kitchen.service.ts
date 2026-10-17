import type { Database, DbClient } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AutoAcceptMode, PredictionKind } from '../../generated/prisma/enums.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { notify } from '../notifications/notifications.service.js';
import { orderNotice } from '../notifications/order-notices.js';
import { deliverSoon } from '../notifications/deliver.js';
import {
  calibration,
  clampCalibration,
  dishEstimate,
  emaUpdate,
  ESTIMATOR_VERSION,
  ETA_NOTICE_MINUTES,
  MAX_ETA_NOTICES,
  median,
  orderBaseMinutes,
  OUTLIER_CLAMP,
  RANGE_MIN_EVALUATED,
  RANGE_WINDOW_DAYS,
  scheduleQueue,
  validDuration,
  type QueueOrder,
} from './kitchen.rules.js';

/*
 * Kitchen queue and preparation estimates (docs/kitchen-queue.md). Order records are the only
 * source: queue positions come from the outlet's active orders, durations from real status
 * timestamps. Estimates are approximate and labelled as such; nothing here changes an order.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Current estimate (and its source) for each dish. */
export async function dishEstimates(db: DbClient, menuItemIds: string[]) {
  const items = await db.menuItem.findMany({
    where: { id: { in: [...new Set(menuItemIds)] } },
    select: { id: true, prepMinutes: true, prepStat: true },
  });
  return new Map(
    items.map((i) => [
      i.id,
      { ...dishEstimate(i.prepMinutes, i.prepStat), configured: i.prepMinutes },
    ]),
  );
}

const orderMinutes = (
  lines: { menuItemId: string; quantity: number }[],
  estimates: Map<string, { minutes: number }>,
  factor: number,
) =>
  orderBaseMinutes(
    lines.map((l) => ({
      minutes: estimates.get(l.menuItemId)?.minutes ?? 10,
      quantity: l.quantity,
    })),
  ) * factor;

/**
 * Records a real preparation time when an order becomes READY — inside that transition, so it
 * happens exactly once. Preparation duration = PREPARING → READY. Dish-level history is learned
 * only from orders of a single dish, single unit (the only case where the whole duration belongs
 * to one dish); every order updates the outlet calibration. Invalid timings are ignored.
 */
export async function recordReadyObservation(tx: DbClient, orderId: string, readyAt: Date) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: true,
      history: { where: { toStatus: 'PREPARING' }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  // Close out any predictions for evaluation (prediction vs actual ready time).
  const predictions = await tx.orderPrediction.findMany({
    where: { orderId, actualReadyAt: null },
  });
  for (const p of predictions) {
    await tx.orderPrediction.update({
      where: { id: p.id },
      data: {
        actualReadyAt: readyAt,
        absErrorSeconds: Math.round(
          Math.abs(p.predictedReadyAt.getTime() - readyAt.getTime()) / 1000,
        ),
      },
    });
  }

  const seconds = validDuration(order.history[0]?.createdAt ?? null, readyAt);
  if (seconds === null) {
    logger.warn(
      { orderId, startedAt: order.history[0]?.createdAt ?? null },
      'Invalid preparation timing ignored',
    );
    return;
  }

  const estimates = await dishEstimates(
    tx,
    order.items.map((i) => i.menuItemId),
  );
  const base = orderBaseMinutes(
    order.items.map((i) => ({
      minutes: estimates.get(i.menuItemId)!.minutes,
      quantity: i.quantity,
    })),
  );

  // Dish history: single dish, single unit only.
  if (order.items.length === 1 && order.items[0]!.quantity === 1) {
    const line = order.items[0]!;
    const prev = await tx.prepTimeStat.findUnique({ where: { menuItemId: line.menuItemId } });
    const seed = prev?.emaSeconds ?? null;
    await tx.prepTimeStat.upsert({
      where: { menuItemId: line.menuItemId },
      create: {
        menuItemId: line.menuItemId,
        outletId: order.outletId,
        emaSeconds: seconds,
        observations: 1,
        lastDurationSeconds: Math.round(seconds),
        lastObservedAt: readyAt,
      },
      update: {
        emaSeconds: emaUpdate(seed, seconds),
        observations: { increment: 1 },
        lastDurationSeconds: Math.round(seconds),
        lastObservedAt: readyAt,
      },
    });
  }

  // Outlet calibration: actual ÷ estimated, clamped so one odd order can't swing it.
  if (base > 0) {
    const ratio = Math.min(OUTLIER_CLAMP, Math.max(1 / OUTLIER_CLAMP, seconds / 60 / base));
    const stat = await tx.outletKitchenStat.findUnique({ where: { outletId: order.outletId } });
    const next = clampCalibration(emaUpdate(stat ? stat.calibrationFactor : null, ratio));
    await tx.outletKitchenStat.upsert({
      where: { outletId: order.outletId },
      create: { outletId: order.outletId, calibrationFactor: next, observations: 1 },
      update: { calibrationFactor: next, observations: { increment: 1 } },
    });
  }
}

/** ± median absolute error of recent evaluated predictions, when there are enough of them. */
async function outletRange(tx: DbClient, outletId: string, now: Date) {
  const rows = await tx.orderPrediction.findMany({
    where: {
      outletId,
      absErrorSeconds: { not: null },
      predictedAt: { gte: new Date(now.getTime() - RANGE_WINDOW_DAYS * DAY_MS) },
    },
    select: { absErrorSeconds: true },
  });
  if (rows.length < RANGE_MIN_EVALUATED) return null;
  return Math.max(1, Math.round(median(rows.map((r) => r.absErrorSeconds! / 60))!));
}

/**
 * Recalculates every active order's estimate at one outlet (serialised per outlet with an
 * advisory lock). Writes OrderEstimate rows, removes them for orders that are no longer kitchen
 * work, and — for accepted/preparing orders — tells the student once their estimated ready time
 * has moved by ETA_NOTICE_MINUTES (at most MAX_ETA_NOTICES times). Returns the orders whose
 * estimate changed, for live updates.
 */
export async function recalculateOutlet(db: Database, outletId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kitchen-recalc:${outletId}`}))`;
    const outlet = await tx.outlet.findUniqueOrThrow({
      where: { id: outletId },
      include: { kitchenStat: true },
    });
    const orders = await tx.order.findMany({
      where: { outletId, status: { in: ['PLACED', 'ACCEPTED', 'PREPARING'] } },
      include: {
        items: { select: { menuItemId: true, quantity: true } },
        history: { where: { toStatus: 'PREPARING' }, orderBy: { createdAt: 'desc' }, take: 1 },
        estimate: true,
      },
    });
    const estimates = await dishEstimates(
      tx,
      orders.flatMap((o) => o.items.map((i) => i.menuItemId)),
    );
    const factor = calibration(outlet.kitchenStat);
    const queue: QueueOrder[] = orders.map((o) => ({
      id: o.id,
      status: o.status as QueueOrder['status'],
      placedAt: o.placedAt,
      scheduledFor: o.scheduledFor,
      prepStartedAt: o.status === 'PREPARING' ? (o.history[0]?.createdAt ?? null) : null,
      minutes: orderMinutes(o.items, estimates, factor),
    }));
    const plan = scheduleQueue(queue, outlet.kitchenParallelOrders, now);
    const range = await outletRange(tx, outletId, now);

    const changed: { orderId: string; userId: string }[] = [];
    for (const o of orders) {
      const p = plan.get(o.id)!;
      const minutes = queue.find((q) => q.id === o.id)!.minutes;
      const prev = o.estimate;
      let notifiedReadyAt = prev?.notifiedReadyAt ?? null;
      let etaNoticeCount = prev?.etaNoticeCount ?? 0;
      if (o.status === 'ACCEPTED' || o.status === 'PREPARING') {
        if (!notifiedReadyAt) {
          notifiedReadyAt = p.readyAt;
        } else if (
          Math.abs(p.readyAt.getTime() - notifiedReadyAt.getTime()) >=
            ETA_NOTICE_MINUTES * MINUTE_MS &&
          etaNoticeCount < MAX_ETA_NOTICES
        ) {
          etaNoticeCount += 1;
          notifiedReadyAt = p.readyAt;
          const later = p.readyAt.getTime() > (prev?.notifiedReadyAt?.getTime() ?? 0);
          await notify(
            tx,
            orderNotice(
              { id: o.id, userId: o.userId, pickupCode: o.pickupCode, outletName: outlet.name },
              'ORDER_ETA_CHANGED',
              {
                title: `Order ${o.pickupCode}: new estimate`,
                body: `${later ? 'Running a little late' : 'Ahead of schedule'}: now estimated around ${p.readyAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} (approximate).`,
              },
              `ETA:${etaNoticeCount}`,
            ),
          );
        }
      }
      const data = {
        outletId,
        queuePosition: p.position,
        ordersAhead: p.ordersAhead,
        prepMinutes: Math.round(minutes * 10) / 10,
        predictedStartAt: p.startAt,
        predictedReadyAt: p.readyAt,
        rangeMinutes: range,
        notifiedReadyAt,
        etaNoticeCount,
        version: ESTIMATOR_VERSION,
      };
      await tx.orderEstimate.upsert({
        where: { orderId: o.id },
        create: { orderId: o.id, ...data },
        update: data,
      });
      if (
        !prev ||
        prev.queuePosition !== p.position ||
        Math.abs(prev.predictedReadyAt.getTime() - p.readyAt.getTime()) >= MINUTE_MS
      ) {
        changed.push({ orderId: o.id, userId: o.userId });
      }
    }
    // Orders that left the kitchen (ready, collected, ended) have no estimate any more.
    await tx.orderEstimate.deleteMany({
      where: { outletId, orderId: { notIn: orders.map((o) => o.id) } },
    });
    return changed;
  });
}

/** Stores what was predicted at acceptance / preparation start (once per order and kind). */
export async function snapshotPrediction(db: Database, orderId: string, kind: PredictionKind) {
  const estimate = await db.orderEstimate.findUnique({
    where: { orderId },
    include: { order: { include: { outlet: { include: { kitchenStat: true } } } } },
  });
  if (!estimate) return;
  await db.orderPrediction.createMany({
    data: [
      {
        orderId,
        outletId: estimate.outletId,
        kind,
        predictedReadyAt: estimate.predictedReadyAt,
        version: estimate.version,
        // Only what was known at prediction time (no future timestamps): see docs.
        context: {
          queuePosition: estimate.queuePosition,
          ordersAhead: estimate.ordersAhead,
          prepMinutes: estimate.prepMinutes,
          parallelOrders: estimate.order.outlet.kitchenParallelOrders,
          calibration: calibration(estimate.order.outlet.kitchenStat),
          scheduled: estimate.order.timing === 'SCHEDULED',
        } satisfies Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Everything to run after an order change commits: recalculate the outlet's queue, snapshot
 * predictions at acceptance / preparation start, push live updates and deliver notifications.
 * Never throws (the background worker repeats recalculation anyway).
 */
export async function afterOrderChange(
  db: Database,
  realtime: RealtimePublisher,
  outletId: string,
  event?: { orderId: string; to: string },
) {
  try {
    const changed = await recalculateOutlet(db, outletId);
    if (event?.to === 'ACCEPTED') await snapshotPrediction(db, event.orderId, 'AT_ACCEPT');
    if (event?.to === 'PREPARING') await snapshotPrediction(db, event.orderId, 'AT_PREP_START');
    for (const c of changed) realtime.estimateUpdated(c.orderId, c.userId, outletId);
    deliverSoon(db, realtime);
  } catch (err) {
    logger.error({ err, outletId }, 'Queue recalculation failed');
  }
}

// ─── Read models ─────────────────────────────────────────────────────────────

/** The student's tracking view of their own order: real timeline + latest estimate. */
export async function trackingFor(db: Database, userId: string, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    include: { history: { orderBy: { createdAt: 'asc' } }, estimate: true, handover: true },
  });
  if (!order) throw notFound('Order not found');
  const at = (status: string) =>
    order.history
      .filter((h) => h.toStatus === status)
      .at(-1)
      ?.createdAt.toISOString() ?? null;
  const e = order.estimate;
  return {
    orderId: order.id,
    status: order.status,
    timeline: order.history.map((h) => ({
      status: h.toStatus,
      at: h.createdAt.toISOString(),
      reason: h.reason,
    })),
    readyAt: at('READY'),
    collectedAt: order.handover?.handedOverAt.toISOString() ?? at('COMPLETED'),
    /** Approximate, recalculated as the queue changes; null when ready or ended. */
    estimate:
      e && ['PLACED', 'ACCEPTED', 'PREPARING'].includes(order.status)
        ? {
            queuePosition: e.queuePosition,
            ordersAhead: e.ordersAhead,
            predictedReadyAt: e.predictedReadyAt.toISOString(),
            rangeMinutes: e.rangeMinutes,
            awaitingAcceptance: order.status === 'PLACED',
            updatedAt: e.updatedAt.toISOString(),
          }
        : null,
  };
}

/** Manager view: kitchen settings and every dish's configured vs learned time. */
export async function kitchenOverview(db: Database, outletId: string) {
  const outlet = await db.outlet.findUniqueOrThrow({
    where: { id: outletId },
    include: { kitchenStat: true },
  });
  const items = await db.menuItem.findMany({
    where: { outletId, isActive: true },
    include: { category: true, prepStat: true },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  return {
    settings: {
      kitchenParallelOrders: outlet.kitchenParallelOrders,
      autoAcceptMode: outlet.autoAcceptMode,
      autoAcceptMaxWaitMinutes: outlet.autoAcceptMaxWaitMinutes,
    },
    calibration: {
      factor: Math.round(calibration(outlet.kitchenStat) * 100) / 100,
      learnedFactor: outlet.kitchenStat
        ? Math.round(outlet.kitchenStat.calibrationFactor * 100) / 100
        : null,
      observations: outlet.kitchenStat?.observations ?? 0,
    },
    dishes: items.map((i) => {
      const estimate = dishEstimate(i.prepMinutes, i.prepStat);
      return {
        id: i.id,
        name: i.name,
        category: i.category.name,
        prepMinutes: i.prepMinutes,
        prepUpdatedAt: i.prepUpdatedAt?.toISOString() ?? null,
        history: i.prepStat
          ? {
              emaMinutes: Math.round((i.prepStat.emaSeconds / 60) * 10) / 10,
              observations: i.prepStat.observations,
              lastDurationMinutes:
                i.prepStat.lastDurationSeconds === null
                  ? null
                  : Math.round((i.prepStat.lastDurationSeconds / 60) * 10) / 10,
              lastObservedAt: i.prepStat.lastObservedAt?.toISOString() ?? null,
            }
          : null,
        estimate: { minutes: Math.round(estimate.minutes * 10) / 10, source: estimate.source },
      };
    }),
  };
}

export async function updatePrepMinutes(
  db: Database,
  input: { outletId: string; menuItemId: string; prepMinutes: number | null; actorUserId: string },
) {
  await db.$transaction(async (tx) => {
    const item = await tx.menuItem.findFirst({
      where: { id: input.menuItemId, outletId: input.outletId },
    });
    if (!item) throw notFound('Dish not found');
    await tx.menuItem.update({
      where: { id: item.id },
      data: { prepMinutes: input.prepMinutes, prepUpdatedAt: new Date() },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: input.actorUserId },
      action: 'MENU_PREP_TIME_UPDATED',
      entityType: 'MenuItem',
      entityId: item.id,
      metadata: { outletId: input.outletId, from: item.prepMinutes, to: input.prepMinutes },
    });
  });
}

export async function updateKitchenSettings(
  db: Database,
  input: {
    outletId: string;
    actorUserId: string;
    kitchenParallelOrders: number;
    autoAcceptMode: AutoAcceptMode;
    autoAcceptMaxWaitMinutes: number;
  },
) {
  await db.$transaction(async (tx) => {
    const before = await tx.outlet.findUniqueOrThrow({ where: { id: input.outletId } });
    await tx.outlet.update({
      where: { id: input.outletId },
      data: {
        kitchenParallelOrders: input.kitchenParallelOrders,
        autoAcceptMode: input.autoAcceptMode,
        autoAcceptMaxWaitMinutes: input.autoAcceptMaxWaitMinutes,
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: input.actorUserId },
      action: 'KITCHEN_SETTINGS_UPDATED',
      entityType: 'Outlet',
      entityId: input.outletId,
      metadata: {
        from: {
          kitchenParallelOrders: before.kitchenParallelOrders,
          autoAcceptMode: before.autoAcceptMode,
          autoAcceptMaxWaitMinutes: before.autoAcceptMaxWaitMinutes,
        },
        to: {
          kitchenParallelOrders: input.kitchenParallelOrders,
          autoAcceptMode: input.autoAcceptMode,
          autoAcceptMaxWaitMinutes: input.autoAcceptMaxWaitMinutes,
        },
      },
    });
  });
}
