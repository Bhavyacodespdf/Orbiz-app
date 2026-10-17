import type { OrderStatus } from '@/services/orders';

/** Button labels for moving an order to each status. */
export const actionLabels: Partial<Record<OrderStatus, string>> = {
  ACCEPTED: 'Accept',
  PREPARING: 'Start preparing',
  READY: 'Mark ready',
  COMPLETED: 'Hand over',
  REJECTED: 'Reject',
  CANCELLED: 'Cancel order',
};

/** Rejecting and cancelling need a reason the student will see. */
export const needsReason = (to: OrderStatus) => to === 'REJECTED' || to === 'CANCELLED';

/** The forward step for the queue's primary button, if the role allows it. */
export function primaryNext(allowed: OrderStatus[]): OrderStatus | undefined {
  return allowed.find((s) => !needsReason(s));
}
