import type { OrderStatus } from '@/services/orders';

export const statusLabels: Record<OrderStatus, string> = {
  PLACED: 'Placed — waiting for the outlet to accept',
  ACCEPTED: 'Accepted',
  PREPARING: 'Being prepared',
  READY: 'Ready for pickup',
  COMPLETED: 'Collected',
  REJECTED: 'Rejected by the outlet',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Not collected in time',
};

/** Sentence added to refund messages when the scheduled-order fee is kept, else ''. */
export const feeKeptNote = (order: {
  refundPaise: number;
  totalPaise: number;
  scheduledFeePaise: number;
}) =>
  order.scheduledFeePaise > 0 && order.refundPaise < order.totalPaise
    ? ' The ₹10 scheduled-order fee isn’t refunded.'
    : '';

/** Sentence added to refund/cancel messages when loyalty points were used, else ''. */
export const pointsReturnNote = (order: { pointsRedeemed: number }) =>
  order.pointsRedeemed > 0
    ? ` The ${order.pointsRedeemed} ${order.pointsRedeemed === 1 ? 'point' : 'points'} used will be returned too.`
    : '';
