import type { Database, DbClient } from '../../lib/prisma.js';
import { revokeCredentials } from '../pickup/pickup.service.js';
import { notify } from '../notifications/notifications.service.js';
import { noShowNotice } from '../notifications/order-notices.js';
import { AppError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { refundToBalance } from '../wallet/wallet.service.js';
import { MAX_STOCK } from '../inventory/stock.js';
import {
  NO_SHOW_GRACE_MINUTES,
  isRefundable,
  paidPerLine,
  pickupDeadline,
  splitRefund,
} from './noshow.rules.js';

/*
 * Settles one scheduled order that was READY but not collected by its deadline.
 *
 * Everything — the wallet credit, its ledger row, restocking, the order's status and
 * payment status, the per-line outcome, the settlement record and the audit entry — is
 * one database transaction. So it either all happens or none of it does, and a retry
 * after a failure starts clean.
 *
 * Only once: the order row is locked (FOR UPDATE SKIP LOCKED, so two workers never wait
 * on each other) and must still be READY; the status change is conditional; the refund has
 * a unique idempotency key and unique (orderId, type); restocking uses the unique
 * (orderId, menuItemId, ORDER_RESTORE) stock entry; the settlement is unique per order.
 * A pickup confirmed at the same moment wins or loses cleanly: both need the order to
 * still be READY.
 */

export type NoShowTrigger = { type: 'SYSTEM' } | { type: 'ADMIN'; userId: string };

async function utcNow(db: DbClient): Promise<Date> {
  const rows = await db.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  return rows[0]!.now;
}

export interface NoShowOutcome {
  orderId: string;
  userId: string;
  outletId: string;
  refundPaise: number;
  restockedItemIds: string[];
}

export async function processNoShow(
  db: Database,
  orderId: string,
  trigger: NoShowTrigger = { type: 'SYSTEM' },
): Promise<NoShowOutcome | null> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE id = ${orderId}::uuid AND status = 'READY' AND timing = 'SCHEDULED'
          AND NOT ("paymentMethod" = 'COUNTER' AND "paymentStatus" = 'PAID')
        FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return null; // collected, already settled, or another worker has it

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: { orderBy: { id: 'asc' } }, outlet: true },
      });
      const deadline = pickupDeadline(order.scheduledFor!);
      const now = await utcNow(tx);
      if (now < deadline) return null; // still inside the grace period

      // Money actually paid per line (wallet orders only; counter orders weren't paid).
      const paid = paidPerLine(order.items, {
        pointsDiscountPaise: order.pointsDiscountPaise,
        paid: order.paymentMethod === 'WALLET' && order.paymentStatus === 'PAID',
      });
      const lines = order.items.map((item, i) => {
        const refundable = isRefundable(item.fulfillmentType);
        const split = refundable ? splitRefund(paid[i]!) : { refundPaise: 0, feePaise: 0 };
        return {
          item,
          paidPaise: paid[i]!,
          refundPaise: split.refundPaise,
          // Handmade lines: nothing refunded, so nothing is a "convenience fee" either.
          feePaise: refundable ? split.feePaise : 0,
          retainedPaise: refundable ? split.feePaise : paid[i]!,
          restockable: refundable && !item.unsuitableForResale,
        };
      });
      const refundPaise = lines.reduce((s, l) => s + l.refundPaise, 0);
      const convenienceFeePaise = lines.reduce((s, l) => s + l.feePaise, 0);

      // 1. Refund to the wallet that paid (from the order's own debit — never from input).
      let refundTransactionId: string | null = null;
      if (refundPaise > 0) {
        const debit = await tx.walletTransaction.findUniqueOrThrow({
          where: { orderId_type: { orderId, type: 'ORDER_DEBIT' } },
        });
        if (refundPaise > debit.amountPaise - order.scheduledFeePaise) {
          throw new Error('Refund would exceed the amount paid for food');
        }
        const balanceAfter = await refundToBalance(tx, debit.walletId, refundPaise);
        const refund = await tx.walletTransaction.create({
          data: {
            walletId: debit.walletId,
            type: 'REFUND',
            direction: 'CREDIT',
            amountPaise: refundPaise,
            balanceAfterPaise: balanceAfter,
            status: 'COMPLETED',
            completedAt: now,
            orderId,
            reversesTransactionId: debit.id,
            idempotencyKey: `noshow-refund:${orderId}`,
            description: `No-show refund for order ${order.pickupCode}: 90% of packaged items (10% convenience fee and ₹10 scheduled-order fee kept)`,
            isSimulated: debit.isSimulated,
          },
        });
        refundTransactionId = refund.id;
      }

      // 2. Restock packaged lines that are still fit to sell, by exactly what was deducted.
      const restockedItemIds: string[] = [];
      const restockedQty = new Map<string, number>();
      for (const line of lines.filter((l) => l.restockable)) {
        const deduction = await tx.stockAdjustment.findUnique({
          where: {
            orderId_menuItemId_type: {
              orderId,
              menuItemId: line.item.menuItemId,
              type: 'ORDER_DEDUCTION',
            },
          },
        });
        if (!deduction) continue; // stock wasn't counted for this item: nothing to put back
        const quantity = Math.min(-deduction.quantityChange, line.item.quantity);
        const rows = await tx.$queryRaw<{ stockQuantity: number }[]>`
          UPDATE "MenuItem"
          SET "stockQuantity" = LEAST("stockQuantity" + ${quantity}, ${MAX_STOCK}),
              "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
          WHERE id = ${line.item.menuItemId}::uuid AND "trackInventory"
          RETURNING "stockQuantity"`;
        if (rows.length === 0) continue; // tracking switched off since: no quantity to restore
        await tx.stockAdjustment.create({
          data: {
            menuItemId: line.item.menuItemId,
            outletId: order.outletId,
            type: 'ORDER_RESTORE',
            quantityChange: quantity,
            previousQuantity: rows[0]!.stockQuantity - quantity,
            resultingQuantity: rows[0]!.stockQuantity,
            orderId,
            reason: 'SCHEDULED_ORDER_NO_SHOW',
          },
        });
        restockedItemIds.push(line.item.menuItemId);
        restockedQty.set(line.item.id, quantity);
      }

      // 3. The order: terminal NO_SHOW, payment status to match what happened.
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: 'READY', version: order.version },
        data: {
          status: 'NO_SHOW',
          paymentStatus:
            order.paymentMethod === 'COUNTER'
              ? 'VOID'
              : refundPaise > 0
                ? 'PARTIALLY_REFUNDED'
                : 'PAID',
          version: { increment: 1 },
        },
      });
      if (count === 0) throw new Error('Order changed during no-show processing');
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: 'READY',
          toStatus: 'NO_SHOW',
          actorUserId: trigger.type === 'ADMIN' ? trigger.userId : null,
          actorRole: trigger.type === 'ADMIN' ? 'ADMIN' : null,
          reason: `Not collected within ${NO_SHOW_GRACE_MINUTES} minutes of the scheduled pickup time`,
        },
      });
      for (const line of lines) {
        await tx.orderItem.update({
          where: { id: line.item.id },
          data: {
            noShowPaidPaise: line.paidPaise,
            noShowRefundPaise: line.refundPaise,
            noShowFeePaise: line.paidPaise - line.refundPaise,
            noShowRestockedQty: restockedQty.get(line.item.id) ?? 0,
          },
        });
      }

      const settlement = {
        status: 'PROCESSED' as const,
        pickupDeadline: deadline,
        processedAt: now,
        lastError: null,
        refundPaise,
        convenienceFeePaise,
        scheduledFeeRetainedPaise: order.scheduledFeePaise,
        restockedUnits: [...restockedQty.values()].reduce((a, b) => a + b, 0),
        refundTransactionId,
      };
      await notify(
        tx,
        noShowNotice(
          {
            id: order.id,
            userId: order.userId,
            pickupCode: order.pickupCode,
            outletName: order.outlet.name,
          },
          refundPaise,
        ),
      );
      // The student can no longer collect: their pickup code stops working.
      await revokeCredentials(
        tx,
        orderId,
        'ORDER_NO_SHOW',
        trigger.type === 'ADMIN' ? { type: 'USER', userId: trigger.userId } : { type: 'SYSTEM' },
      );
      await tx.noShowSettlement.upsert({
        where: { orderId },
        create: { orderId, attempts: 1, ...settlement },
        update: { attempts: { increment: 1 }, ...settlement },
      });
      await recordAudit(tx, {
        actor:
          trigger.type === 'ADMIN' ? { type: 'USER', userId: trigger.userId } : { type: 'SYSTEM' },
        action: 'ORDER_NO_SHOW_PROCESSED',
        entityType: 'Order',
        entityId: orderId,
        metadata: {
          outletId: order.outletId,
          scheduledFor: order.scheduledFor!.toISOString(),
          pickupDeadline: deadline.toISOString(),
          refundPaise,
          convenienceFeePaise,
          scheduledFeeRetainedPaise: order.scheduledFeePaise,
          refundDestination: refundPaise > 0 ? 'CAMPUSCART_WALLET' : null,
          lines: lines.map((l) => ({
            orderItemId: l.item.id,
            fulfillmentType: l.item.fulfillmentType ?? 'UNCLASSIFIED',
            paidPaise: l.paidPaise,
            refundPaise: l.refundPaise,
            restockedQty: restockedQty.get(l.item.id) ?? 0,
            unsuitableForResale: l.item.unsuitableForResale,
          })),
        },
      });
      return {
        orderId,
        userId: order.userId,
        outletId: order.outletId,
        refundPaise,
        restockedItemIds,
      };
    });
  } catch (error) {
    // Nothing above was committed. Record the failure (outside that transaction) so staff
    // can see it; the worker tries again next time and an admin can retry immediately.
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
    logger.error({ err: error, orderId }, 'No-show processing failed; will retry');
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (order?.scheduledFor) {
      await db.noShowSettlement.upsert({
        where: { orderId },
        create: {
          orderId,
          status: 'FAILED',
          pickupDeadline: pickupDeadline(order.scheduledFor),
          attempts: 1,
          lastError: message,
        },
        update: { status: 'FAILED', attempts: { increment: 1 }, lastError: message },
      });
    }
    throw new AppError(500, 'NO_SHOW_FAILED', 'No-show processing failed and will be retried.');
  }
}

/** Ready scheduled orders whose grace period is over (by the database clock), oldest first. */
export async function dueNoShows(db: Database, limit = 50) {
  const now = await utcNow(db);
  const rows = await db.order.findMany({
    where: {
      timing: 'SCHEDULED',
      status: 'READY',
      // Cash already taken at the counter can't be refunded by the app: staff settle it in person.
      NOT: { paymentMethod: 'COUNTER', paymentStatus: 'PAID' },
      scheduledFor: { lte: new Date(now.getTime() - NO_SHOW_GRACE_MINUTES * 60_000) },
    },
    select: { id: true },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  });
  return rows.map((r) => r.id);
}

/** One pass of the worker. Failures are recorded per order and never stop the others. */
export async function processDueNoShows(
  db: Database,
  onSettled: (outcome: NoShowOutcome) => void = () => {},
) {
  let processed = 0;
  let failed = 0;
  for (const orderId of await dueNoShows(db)) {
    try {
      const outcome = await processNoShow(db, orderId);
      if (outcome) {
        processed += 1;
        onSettled(outcome);
      }
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}

/**
 * Staff flag a packaged line as not fit to sell again before the order is settled
 * (opened, damaged, expired). It is then refunded as usual but never restocked.
 */
export async function markUnsuitable(
  db: Database,
  params: {
    outletId: string;
    orderId: string;
    menuItemId: string;
    reason: string;
    actorUserId: string;
  },
) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: params.orderId, outletId: params.outletId },
      include: { items: true },
    });
    if (!order) throw notFound('Order not found');
    if (
      order.timing !== 'SCHEDULED' ||
      !['READY', 'PREPARING', 'ACCEPTED', 'PLACED'].includes(order.status)
    ) {
      throw new AppError(
        409,
        'NOT_APPLICABLE',
        'Only scheduled orders that haven’t been settled can be flagged.',
      );
    }
    const line = order.items.find((i) => i.menuItemId === params.menuItemId);
    if (!line) throw notFound('That item isn’t in this order');
    if (line.fulfillmentType !== 'PACKAGED') {
      throw new AppError(
        409,
        'NOT_PACKAGED',
        'Only packaged items can be restocked, so only they can be flagged.',
      );
    }
    await tx.orderItem.update({
      where: { id: line.id },
      data: { unsuitableForResale: true, unsuitableReason: params.reason },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: params.actorUserId },
      action: 'ORDER_ITEM_MARKED_UNSUITABLE',
      entityType: 'OrderItem',
      entityId: line.id,
      metadata: { orderId: order.id, menuItemId: params.menuItemId, reason: params.reason },
    });
    return order.id;
  });
}
