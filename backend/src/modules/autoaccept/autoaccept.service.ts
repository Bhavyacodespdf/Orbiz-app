import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Order } from '../../generated/prisma/client.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { transitionOrder } from '../orders/transitions.js';
import { notifyOutletStaff } from '../notifications/notifications.service.js';
import { afterOrderChange, recalculateOutlet } from '../kitchen/kitchen.service.js';
import { DELAY_MINUTES } from '../kitchen/kitchen.rules.js';
import { inStock } from '../inventory/stock.js';

/*
 * Rule-based automatic acceptance (docs/kitchen-queue.md). Not machine learning: an order is
 * accepted automatically only if EVERY rule passes; otherwise it simply stays with staff, as
 * today, with the reason recorded. It never rejects an order and never changes payment.
 *
 * Mapping to CampusCart's lifecycle: stock is deducted and the outlet's rolling 10-orders-per-3-
 * minutes capacity is claimed at checkout (when the order is taken on), exactly once. Accepting —
 * by staff or by these rules — is the PLACED → ACCEPTED transition, which uses neither again.
 */

export const RULE_VERSION = 'auto-accept-v1';
/** A manager alert after this many fallbacks to staff within the window. */
export const FALLBACK_ALERT_COUNT = 3;
export const FALLBACK_ALERT_WINDOW_MINUTES = 15;

const MINUTE_MS = 60_000;

export type IneligibleReason =
  | 'OUTLET_NOT_OPEN'
  | 'AUTO_ACCEPT_OFF'
  | 'PAYMENT_AT_COUNTER'
  | 'ITEM_NOT_AVAILABLE'
  | 'NOT_COUNTED_FOR_CAPACITY'
  | 'NO_ESTIMATE'
  | 'QUEUE_TOO_LONG'
  | 'SCHEDULE_AT_RISK'
  | 'SYSTEM_ERROR';

const REASON_TEXT: Record<IneligibleReason, string> = {
  OUTLET_NOT_OPEN: 'the outlet isn’t open',
  AUTO_ACCEPT_OFF: 'auto-accept was turned off',
  PAYMENT_AT_COUNTER: 'it’s paid at the counter',
  ITEM_NOT_AVAILABLE: 'a dish is no longer available',
  NOT_COUNTED_FOR_CAPACITY: 'it wasn’t counted against the order limit',
  NO_ESTIMATE: 'its wait couldn’t be estimated',
  QUEUE_TOO_LONG: 'the estimated wait is over your limit',
  SCHEDULE_AT_RISK: 'it may not be ready by its scheduled time',
  SYSTEM_ERROR: 'the automatic check couldn’t complete',
};

/** Rules that depend on the order, outlet and menu (re-checked inside the acceptance transaction). */
async function orderRules(tx: DbClient, order: Order): Promise<IneligibleReason[]> {
  const reasons: IneligibleReason[] = [];
  const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: order.outletId } });
  if (outlet.autoAcceptMode !== 'AUTO') reasons.push('AUTO_ACCEPT_OFF');
  if (!outlet.isActive || outlet.status !== 'OPEN') reasons.push('OUTLET_NOT_OPEN');
  // Only prepaid orders: counter orders involve cash, which staff handle.
  if (order.paymentStatus !== 'PAID') reasons.push('PAYMENT_AT_COUNTER');
  const lines = await tx.orderItem.findMany({
    where: { orderId: order.id },
    include: { menuItem: { include: { category: true } } },
  });
  const unavailable = lines.some(
    (l) =>
      !l.menuItem.isActive ||
      !l.menuItem.category.isActive ||
      // Counted stock was already taken at checkout; untracked dishes mustn't be marked sold out.
      (!l.menuItem.trackInventory && !inStock(l.menuItem)),
  );
  if (unavailable) reasons.push('ITEM_NOT_AVAILABLE');
  const counted = await tx.outletOrderAcceptance.findUnique({ where: { orderId: order.id } });
  if (!counted) reasons.push('NOT_COUNTED_FOR_CAPACITY');
  return reasons;
}

/** Queue rules from the order's current estimate. */
async function queueRules(db: Database, order: Order, now: Date): Promise<IneligibleReason[]> {
  const [estimate, outlet] = await Promise.all([
    db.orderEstimate.findUnique({ where: { orderId: order.id } }),
    db.outlet.findUniqueOrThrow({ where: { id: order.outletId } }),
  ]);
  if (!estimate) return ['NO_ESTIMATE'];
  if (order.scheduledFor) {
    const late = estimate.predictedReadyAt.getTime() - order.scheduledFor.getTime();
    return late > DELAY_MINUTES * MINUTE_MS ? ['SCHEDULE_AT_RISK'] : [];
  }
  const waitMinutes = (estimate.predictedReadyAt.getTime() - now.getTime()) / MINUTE_MS;
  return waitMinutes > outlet.autoAcceptMaxWaitMinutes ? ['QUEUE_TOO_LONG'] : [];
}

class Ineligible extends AppError {
  constructor(public readonly reasons: IneligibleReason[]) {
    super(409, 'AUTO_ACCEPT_INELIGIBLE', 'Not eligible for automatic acceptance.', { reasons });
  }
}

/**
 * Decides one placed order at an AUTO outlet, once (the decision row is claimed first; a
 * second worker or retry finds it and does nothing). Eligible → accepted through the same
 * transition service staff use; otherwise it stays for staff, who are told why.
 */
export async function decideAutoAccept(
  db: Database,
  realtime: RealtimePublisher,
  orderId: string,
  now = new Date(),
) {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { outlet: true } });
  if (!order || order.status !== 'PLACED' || order.outlet.autoAcceptMode !== 'AUTO') return null;

  try {
    await db.autoAcceptDecision.create({
      data: {
        orderId,
        outletId: order.outletId,
        outcome: 'ACCEPTED',
        reasons: [],
        ruleVersion: RULE_VERSION,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already decided
    throw err;
  }

  await recalculateOutlet(db, order.outletId, now);
  const reasons = [...(await orderRules(db, order)), ...(await queueRules(db, order, now))];

  const fallBack = async (why: IneligibleReason[] | 'ALREADY_HANDLED') => {
    if (why === 'ALREADY_HANDLED') {
      await db.autoAcceptDecision.update({
        where: { orderId },
        data: { outcome: 'ALREADY_HANDLED', reasons: [] },
      });
      return 'ALREADY_HANDLED' as const;
    }
    await db.autoAcceptDecision.update({
      where: { orderId },
      data: { outcome: 'MANUAL_REVIEW', reasons: why },
    });
    logger.info(
      { orderId, outletId: order.outletId, reasons: why },
      'Auto-accept fell back to staff',
    );
    await notifyOutletStaff(db, order.outletId, ['MANAGER', 'POS'], {
      type: 'STAFF_MANUAL_REVIEW',
      title: `Order ${order.pickupCode} needs a staff decision`,
      body: `Not accepted automatically because ${why.map((r) => REASON_TEXT[r]).join(' and ')}.`,
      link: '/pos',
      entityType: 'Order',
      entityId: orderId,
      dedupeKey: `order:${orderId}:MANUAL_REVIEW`,
    });
    await alertRepeatedFallbacks(db, order.outletId, now);
    return 'MANUAL_REVIEW' as const;
  };

  if (reasons.length > 0) return fallBack(reasons);

  try {
    const result = await transitionOrder(db, {
      orderId,
      to: 'ACCEPTED',
      actorRoles: [],
      actorUserId: order.userId,
      scope: { outletId: order.outletId },
      system: {
        reason: `Accepted automatically (${RULE_VERSION})`,
        ruleVersion: RULE_VERSION,
        guard: async (tx, locked) => {
          const again = await orderRules(tx, locked);
          if (again.length > 0) throw new Ineligible(again);
        },
      },
    });
    realtime.orderUpdated(result.order, result.ownerId);
    await afterOrderChange(db, realtime, order.outletId, { orderId, to: 'ACCEPTED' });
    return 'ACCEPTED' as const;
  } catch (err) {
    if (err instanceof Ineligible) return fallBack(err.reasons);
    // Staff accepted, rejected or the student cancelled first.
    if (
      err instanceof AppError &&
      ['INVALID_TRANSITION', 'ORDER_CHANGED', 'FORBIDDEN'].includes(err.code)
    ) {
      return fallBack('ALREADY_HANDLED');
    }
    logger.error({ err, orderId }, 'Auto-accept failed; the order stays with staff');
    return fallBack(['SYSTEM_ERROR']);
  }
}

/** Managers hear (hourly at most) when auto-accept keeps handing orders back to staff. */
async function alertRepeatedFallbacks(db: Database, outletId: string, now: Date) {
  const recent = await db.autoAcceptDecision.count({
    where: {
      outletId,
      outcome: 'MANUAL_REVIEW',
      decidedAt: { gte: new Date(now.getTime() - FALLBACK_ALERT_WINDOW_MINUTES * MINUTE_MS) },
    },
  });
  if (recent < FALLBACK_ALERT_COUNT) return;
  await notifyOutletStaff(db, outletId, ['MANAGER'], {
    type: 'MANAGER_AUTO_ACCEPT_FAILURES',
    title: 'Auto-accept keeps handing orders to staff',
    body: `${recent} orders in the last ${FALLBACK_ALERT_WINDOW_MINUTES} minutes needed a staff decision. Check the queue limit and kitchen settings.`,
    link: '/manage/kitchen',
    dedupeKey: `outlet:${outletId}:AUTO_ACCEPT_FAILURES:${now.toISOString().slice(0, 13)}`,
  });
}

/** Safety net: placed orders at AUTO outlets that haven't been decided yet (e.g. after a crash). */
export async function autoAcceptSweep(db: Database, realtime: RealtimePublisher, now = new Date()) {
  const pending = await db.order.findMany({
    where: { status: 'PLACED', outlet: { autoAcceptMode: 'AUTO' }, autoAcceptDecision: null },
    orderBy: { placedAt: 'asc' },
    select: { id: true },
    take: 50,
  });
  let decided = 0;
  for (const o of pending) {
    if (await decideAutoAccept(db, realtime, o.id, now)) decided += 1;
  }
  return decided;
}
