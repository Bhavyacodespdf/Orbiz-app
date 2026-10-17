import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { Outlet, OutletHours } from '../../generated/prisma/client.js';
import { orderInclude, toOrder } from '../orders/orders.serializer.js';
import {
  checkSlot,
  generateSlots,
  istMidnight,
  istDayOf,
  addDays,
  type ScheduleConfig,
} from './slots.js';
import { SCHEDULED_ORDER_FEE_PAISE, TIMEZONE } from './scheduling.rules.js';

export function configOf(outlet: Outlet & { hours: OutletHours[] }): ScheduleConfig {
  return {
    outletActive: outlet.isActive,
    outletStatus: outlet.status,
    leadMinutes: outlet.scheduleLeadMinutes,
    slotMinutes: outlet.scheduleSlotMinutes,
    daysAhead: outlet.scheduleDaysAhead,
    slotCapacity: outlet.scheduleSlotCapacity,
    hours: outlet.hours.map((h) => ({
      weekday: h.weekday,
      opensMinute: h.opensMinute,
      closesMinute: h.closesMinute,
    })),
  };
}

/** Active (not rejected or cancelled) scheduled orders per slot, in a time range. */
async function bookedCounts(
  db: DbClient,
  outletId: string,
  from: Date,
  to: Date,
  excludeOrderId?: string,
) {
  const groups = await db.order.groupBy({
    by: ['scheduledFor'],
    where: {
      outletId,
      timing: 'SCHEDULED',
      status: { notIn: ['REJECTED', 'CANCELLED'] },
      scheduledFor: { gte: from, lt: to },
      ...(excludeOrderId && { id: { not: excludeOrderId } }),
    },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.scheduledFor!.toISOString(), g._count._all]));
}

/** The bookable slots for an outlet, from the server's clock. */
export async function slotsFor(
  db: Database,
  outlet: Outlet & { hours: OutletHours[] },
  nowMs = Date.now(),
) {
  const config = configOf(outlet);
  const today = istDayOf(nowMs);
  const booked = await bookedCounts(
    db,
    outlet.id,
    new Date(nowMs),
    new Date(istMidnight(addDays(today, config.daysAhead + 1))),
  );
  return {
    timezone: TIMEZONE,
    feePaise: SCHEDULED_ORDER_FEE_PAISE,
    leadMinutes: config.leadMinutes,
    slotMinutes: config.slotMinutes,
    days: generateSlots(config, nowMs, booked),
  };
}

/**
 * Checks a slot inside the order transaction. A per-slot advisory lock serialises
 * bookings of the same slot, so the capacity limit can't be exceeded by orders arriving
 * together.
 */
export async function assertSlotBookable(
  tx: DbClient,
  outlet: Outlet & { hours: OutletHours[] },
  scheduledFor: Date,
  excludeOrderId?: string,
) {
  const check = checkSlot(configOf(outlet), Date.now(), scheduledFor);
  if (!check.ok) throw new AppError(409, check.code, check.message);
  if (outlet.scheduleSlotCapacity !== null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`slot:${outlet.id}:${scheduledFor.toISOString()}`}))`;
    const end = new Date(scheduledFor.getTime() + 1);
    const taken =
      (await bookedCounts(tx, outlet.id, scheduledFor, end, excludeOrderId)).get(
        scheduledFor.toISOString(),
      ) ?? 0;
    if (taken >= outlet.scheduleSlotCapacity) {
      throw new AppError(409, 'SLOT_FULL', 'That pickup slot is full. Please choose another time.');
    }
  }
}

export async function loadOutletWithHours(db: DbClient, where: { id: string } | { slug: string }) {
  const outlet = await db.outlet.findFirst({
    where,
    include: { hours: { orderBy: { weekday: 'asc' } } },
  });
  if (!outlet) throw notFound('Outlet not found');
  return outlet;
}

/**
 * The student moves their own scheduled order to another valid slot while it is still
 * PLACED and its current slot is at least the lead time away. The fee is not charged
 * again. Choosing the same slot changes nothing.
 */
export async function rescheduleOrder(
  db: Database,
  params: { userId: string; orderId: string; scheduledFor: Date },
) {
  const outcome = await db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: params.orderId, userId: params.userId },
    });
    if (!order) throw notFound('Order not found');
    if (order.timing !== 'SCHEDULED' || !order.scheduledFor) {
      throw new AppError(409, 'NOT_SCHEDULED', 'Only scheduled orders can be rescheduled.');
    }
    if (order.scheduledFor.getTime() === params.scheduledFor.getTime())
      return { orderId: order.id, changed: false };
    if (order.status !== 'PLACED') {
      throw new AppError(
        409,
        'TOO_LATE_TO_RESCHEDULE',
        'The outlet has already accepted this order, so its time can’t be changed in the app.',
      );
    }
    const outlet = await loadOutletWithHours(tx, { id: order.outletId });
    if (order.scheduledFor.getTime() - Date.now() < outlet.scheduleLeadMinutes * 60_000) {
      throw new AppError(
        409,
        'TOO_LATE_TO_RESCHEDULE',
        'This order is too close to its pickup time to change it.',
      );
    }
    await assertSlotBookable(tx, outlet, params.scheduledFor, order.id);
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: 'PLACED', version: order.version },
      data: { scheduledFor: params.scheduledFor, version: { increment: 1 } },
    });
    if (count === 0)
      throw new AppError(
        409,
        'ORDER_CHANGED',
        'This order was just updated. Refresh and try again.',
      );
    return { orderId: order.id, changed: true };
  });
  const order = await db.order.findUniqueOrThrow({
    where: { id: outcome.orderId },
    include: orderInclude,
  });
  return { order: toOrder(order), ownerId: order.userId, changed: outcome.changed };
}
