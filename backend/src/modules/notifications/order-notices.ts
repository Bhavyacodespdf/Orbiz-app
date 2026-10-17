import type { DbClient } from '../../lib/prisma.js';
import type { NotificationType } from '../../generated/prisma/enums.js';
import { notify, type NotificationInput } from './notifications.service.js';

/*
 * The student-facing order notifications: wording in one place. Messages name the order
 * number (N-007) and outlet only — never the pickup code, payment details or anyone else's data.
 */

export const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;

const clock = (d: Date) =>
  d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

export interface OrderRef {
  id: string;
  userId: string;
  pickupCode: string;
  outletName: string;
  scheduledFor?: Date | null;
}

export function orderNotice(
  order: OrderRef,
  type: NotificationType,
  text: { title: string; body: string },
  dedupeSuffix: string = type,
  userId = order.userId,
): NotificationInput {
  return {
    userId,
    type,
    ...text,
    link: `/orders/${order.id}`,
    entityType: 'Order',
    entityId: order.id,
    dedupeKey: `order:${order.id}:${dedupeSuffix}`,
  };
}

/** Notifications for a status change the order just went through (call inside its transaction). */
export async function notifyOrderStatus(
  tx: DbClient,
  order: OrderRef,
  change: {
    to: string;
    byStudent: boolean;
    reason: string | null;
    refundPaise: number;
    groupRefundUserIds: string[];
  },
) {
  const n = `Order ${order.pickupCode}`;
  const refund =
    change.refundPaise > 0 ? ` ${rupees(change.refundPaise)} was refunded to your wallet.` : '';
  const why = change.reason ? ` Reason: “${change.reason}”.` : '';
  const list: NotificationInput[] = [];
  switch (change.to) {
    case 'ACCEPTED':
      list.push(
        orderNotice(order, 'ORDER_ACCEPTED', {
          title: `${n} accepted`,
          body: `${order.outletName} accepted your order.`,
        }),
      );
      break;
    case 'PREPARING':
      list.push(
        orderNotice(order, 'ORDER_PREPARING', {
          title: `${n} is being prepared`,
          body: `${order.outletName} has started on your food.`,
        }),
      );
      break;
    case 'READY':
      list.push(
        orderNotice(order, 'ORDER_READY', {
          title: `${n} is ready`,
          body: `Collect it at ${order.outletName}. Open the order to show your pickup code.`,
        }),
      );
      break;
    case 'REJECTED':
      list.push(
        orderNotice(order, 'ORDER_REJECTED', {
          title: `${n} couldn’t be accepted`,
          body: `${order.outletName} couldn’t take this order.${why}${refund}`,
        }),
      );
      break;
    case 'CANCELLED':
      list.push(
        orderNotice(order, 'ORDER_CANCELLED', {
          title: change.byStudent ? `You cancelled ${n}` : `${n} was cancelled`,
          body: change.byStudent
            ? `Your order at ${order.outletName} is cancelled.${refund}`
            : `${order.outletName} cancelled your order.${why}${refund}`,
        }),
      );
      break;
  }
  // Group orders: each member whose share came back hears about it.
  if (
    change.groupRefundUserIds.length > 0 &&
    (change.to === 'REJECTED' || change.to === 'CANCELLED')
  ) {
    for (const userId of change.groupRefundUserIds) {
      list.push(
        orderNotice(
          order,
          change.to === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_CANCELLED',
          {
            title: `Group ${n} ${change.to === 'REJECTED' ? 'couldn’t be accepted' : 'was cancelled'}`,
            body: `Your share was refunded to your wallet.${why}`,
          },
          `${change.to}:share`,
          userId,
        ),
      );
    }
  }
  return notify(tx, list);
}

export const placedNotice = (order: OrderRef) =>
  orderNotice(order, 'ORDER_PLACED', {
    title: `Order ${order.pickupCode} placed`,
    body: order.scheduledFor
      ? `${order.outletName} has your order for ${clock(order.scheduledFor)}. We’ll tell you when it’s accepted.`
      : `${order.outletName} has your order. We’ll tell you when it’s accepted.`,
  });

export const collectedNotices = (order: OrderRef, at: Date): NotificationInput[] => [
  orderNotice(order, 'ORDER_COLLECTED', {
    title: `Order ${order.pickupCode} collected`,
    body: `Handed over at ${clock(at)} at ${order.outletName}. Enjoy your food!`,
  }),
  orderNotice(order, 'REVIEW_PROMPT', {
    title: 'How was your food?',
    body: `Rate the dishes from order ${order.pickupCode} — it helps other students choose.`,
  }),
];

export const noShowNotice = (order: OrderRef, refundPaise: number) =>
  orderNotice(order, 'ORDER_NO_SHOW', {
    title: `Order ${order.pickupCode} wasn’t collected`,
    body:
      refundPaise > 0
        ? `It wasn’t picked up in time. ${rupees(refundPaise)} was refunded under the no-show policy.`
        : 'It wasn’t picked up in time, so it was closed under the no-show policy.',
  });
