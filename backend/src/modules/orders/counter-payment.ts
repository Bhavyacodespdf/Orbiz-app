import type { Database } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { orderInclude, toOrder } from './orders.serializer.js';

/**
 * Records money a POS user has physically received at the counter. This is
 * a statement by a person who took the payment — it is never inferred from
 * anything the student does. One record per order, audited.
 */
export async function recordCounterPayment(
  db: Database,
  params: {
    outletId: string;
    orderId: string;
    amountPaise: number;
    note?: string;
    actorUserId: string;
  },
) {
  try {
    const orderId = await db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: params.orderId, outletId: params.outletId },
      });
      if (!order) throw notFound('Order not found');
      if (order.paymentMethod !== 'COUNTER') {
        throw new AppError(409, 'NOT_COUNTER_ORDER', 'This order was paid from the wallet.');
      }
      if (order.paymentStatus === 'PAID')
        throw new AppError(409, 'ALREADY_PAID', 'Payment was already recorded for this order.');
      if (order.paymentStatus !== 'PENDING_COUNTER') {
        throw new AppError(
          409,
          'ORDER_NOT_PAYABLE',
          'This order was cancelled and should not be charged.',
        );
      }
      if (!['ACCEPTED', 'PREPARING', 'READY'].includes(order.status)) {
        throw new AppError(409, 'ORDER_NOT_ACCEPTED', 'Accept the order before taking payment.');
      }
      if (params.amountPaise !== order.totalPaise) {
        throw new AppError(409, 'AMOUNT_MISMATCH', 'The amount must equal the order total.', {
          totalPaise: order.totalPaise,
        });
      }

      const { count } = await tx.order.updateMany({
        where: { id: order.id, paymentStatus: 'PENDING_COUNTER', version: order.version },
        data: { paymentStatus: 'PAID', version: { increment: 1 } },
      });
      if (count === 0) {
        throw new AppError(
          409,
          'ORDER_CHANGED',
          'This order was just updated by someone else. Refresh and try again.',
        );
      }
      await tx.counterPayment.create({
        data: {
          orderId: order.id,
          amountPaise: order.totalPaise,
          recordedById: params.actorUserId,
          note: params.note?.trim() || null,
        },
      });
      await recordAudit(tx, {
        actor: { type: 'USER', userId: params.actorUserId },
        action: 'COUNTER_PAYMENT_RECORDED',
        entityType: 'Order',
        entityId: order.id,
        metadata: {
          outletId: order.outletId,
          pickupCode: order.pickupCode,
          amountPaise: order.totalPaise,
        },
      });
      return order.id;
    });
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: orderInclude,
    });
    return { order: toOrder(order), ownerId: order.userId };
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AppError(409, 'ALREADY_PAID', 'Payment was already recorded for this order.');
    throw error;
  }
}
