import type {
  CounterPayment,
  NoShowSettlement,
  Order,
  OrderItem,
  OrderStatusHistory,
  Outlet,
} from '../../generated/prisma/client.js';
import { refundablePaise } from '../scheduling/scheduling.rules.js';
import { pickupDeadline } from '../noshow/noshow.rules.js';

export type OrderWithDetails = Order & {
  outlet: Outlet;
  items: OrderItem[];
  history: OrderStatusHistory[];
  counterPayment: (CounterPayment & { recordedBy: { displayName: string } }) | null;
  noShow: NoShowSettlement | null;
};

export const orderInclude = {
  outlet: true,
  items: { orderBy: { name: 'asc' as const } },
  history: { orderBy: { createdAt: 'asc' as const } },
  counterPayment: { include: { recordedBy: { select: { displayName: true } } } },
  noShow: true,
};

export function toOrder(order: OrderWithDetails) {
  return {
    id: order.id,
    pickupCode: order.pickupCode,
    outlet: {
      id: order.outlet.id,
      slug: order.outlet.slug,
      name: order.outlet.name,
      location: order.outlet.location,
    },
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    items: order.items.map((i) => ({
      menuItemId: i.menuItemId,
      name: i.name,
      unitPricePaise: i.unitPricePaise,
      quantity: i.quantity,
      lineTotalPaise: i.lineTotalPaise,
      /** PACKAGED / HANDMADE as classified when ordered (null = not classified then). */
      fulfillmentType: i.fulfillmentType,
      unsuitableForResale: i.unsuitableForResale,
      /** Set once the no-show policy has settled this line. */
      noShow:
        i.noShowPaidPaise === null
          ? null
          : {
              paidPaise: i.noShowPaidPaise,
              refundPaise: i.noShowRefundPaise ?? 0,
              feePaise: i.noShowFeePaise ?? 0,
              restockedQuantity: i.noShowRestockedQty ?? 0,
            },
    })),
    subtotalPaise: order.subtotalPaise,
    pointsRedeemed: order.pointsRedeemed,
    pointsDiscountPaise: order.pointsDiscountPaise,
    timing: order.timing,
    scheduledFor: order.scheduledFor,
    scheduledFeePaise: order.scheduledFeePaise,
    totalPaise: order.totalPaise,
    /**
     * What goes back to the wallet if this order is (or was) rejected or cancelled: the
     * amount paid from the wallet, minus the scheduled-order fee under the current rule.
     * 0 for counter orders (nothing was paid in the app).
     */
    refundPaise: order.paymentMethod === 'WALLET' ? refundablePaise(order, order.totalPaise) : 0,
    /** Scheduled orders: collect by this time (slot + 10 minutes) or the no-show policy applies. */
    pickupDeadline: order.scheduledFor ? pickupDeadline(order.scheduledFor) : null,
    /** The no-show settlement, once the policy has run (or failed and is being retried). */
    noShow: order.noShow && {
      status: order.noShow.status,
      processedAt: order.noShow.processedAt,
      refundPaise: order.noShow.refundPaise,
      convenienceFeePaise: order.noShow.convenienceFeePaise,
      scheduledFeeRetainedPaise: order.noShow.scheduledFeeRetainedPaise,
      restockedUnits: order.noShow.restockedUnits,
    },
    currency: order.currency,
    cancelReason: order.cancelReason,
    version: order.version,
    placedAt: order.placedAt,
    updatedAt: order.updatedAt,
    counterPayment: order.counterPayment && {
      amountPaise: order.counterPayment.amountPaise,
      recordedAt: order.counterPayment.recordedAt,
    },
    statusHistory: order.history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      at: h.createdAt,
    })),
  };
}

export const ACTIVE_STATUSES = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'] as const;
export const FINISHED_STATUSES = ['COMPLETED', 'REJECTED', 'CANCELLED', 'NO_SHOW'] as const;

/** Compact row for order lists. */
export function toOrderSummary(order: Order & { outlet: Outlet; items: OrderItem[] }) {
  return {
    id: order.id,
    pickupCode: order.pickupCode,
    outlet: { id: order.outlet.id, slug: order.outlet.slug, name: order.outlet.name },
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    timing: order.timing,
    scheduledFor: order.scheduledFor,
    scheduledFeePaise: order.scheduledFeePaise,
    pickupDeadline: order.scheduledFor ? pickupDeadline(order.scheduledFor) : null,
    totalPaise: order.totalPaise,
    itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
    placedAt: order.placedAt,
    version: order.version,
  };
}

/** Keyset cursor over (placedAt, id), newest first. */
export function encodeOrderCursor(o: { placedAt: Date; id: string }) {
  return Buffer.from(`${o.placedAt.toISOString()}|${o.id}`).toString('base64url');
}

export function decodeOrderCursor(cursor: string): { placedAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const placedAt = new Date(iso ?? '');
  return id && !Number.isNaN(placedAt.getTime()) ? { placedAt, id } : null;
}
