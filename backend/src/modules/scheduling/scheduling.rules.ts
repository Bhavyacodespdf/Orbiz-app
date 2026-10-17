import type { OrderTiming } from '../../generated/prisma/enums.js';

/*
 * Scheduled-order business rules: the ONE place these live.
 */

/** Fixed fee per scheduled order (₹10), never per item. Immediate orders: ₹0. */
export const SCHEDULED_ORDER_FEE_PAISE = 1_000;

export const feeFor = (timing: OrderTiming) =>
  timing === 'SCHEDULED' ? SCHEDULED_ORDER_FEE_PAISE : 0;

/**
 * Whether the ₹10 fee is refunded when a paid scheduled order is rejected or cancelled.
 *
 * Business decision (2026-10-17): the fee is KEPT, whether the student cancels or the outlet
 * rejects — the refund is the total minus ₹10. Everything else paid (the food) is refunded
 * in full, as before. Set to true to refund the fee as well.
 */
export const REFUND_SCHEDULED_FEE_ON_CANCEL = false;

/** How much of a wallet debit goes back when the order is rejected or cancelled. */
export function refundablePaise(order: { scheduledFeePaise: number }, debitPaise: number): number {
  return REFUND_SCHEDULED_FEE_ON_CANCEL ? debitPaise : debitPaise - order.scheduledFeePaise;
}

/** All scheduling uses CampusCart's calendar policy: India Standard Time (no DST). */
export const TIMEZONE = 'Asia/Kolkata';
