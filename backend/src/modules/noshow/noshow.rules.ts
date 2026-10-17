import type { FoodFulfillment } from '../../generated/prisma/enums.js';

/*
 * Scheduled-order no-show policy: the ONE place these rules live.
 *
 *   pickup deadline = scheduledFor + 10 minutes
 *   PACKAGED line  → refund 90% of what was actually paid for it, keep 10%; restock if safe
 *   HANDMADE line  → no refund, never restocked
 *   unclassified   → treated as HANDMADE (the menu item had no classification at placement)
 *   ₹10 scheduled-order fee → kept (non-refundable), recorded separately
 *   loyalty points spent → not returned (only money paid is the refund base)
 */

export const NO_SHOW_GRACE_MINUTES = 10;
export const NO_SHOW_REFUND_PERCENT = 90;

export const pickupDeadline = (scheduledFor: Date) =>
  new Date(scheduledFor.getTime() + NO_SHOW_GRACE_MINUTES * 60_000);

/** PACKAGED is the only classification eligible for refund and restocking. */
export const isRefundable = (type: FoodFulfillment | null) => type === 'PACKAGED';

/**
 * 90% refund rounded DOWN to the paise; the convenience fee is the remainder, so
 * refund + fee always equals the amount paid exactly.
 */
export function splitRefund(paidPaise: number): { refundPaise: number; feePaise: number } {
  const refundPaise = Math.floor((paidPaise * NO_SHOW_REFUND_PERCENT) / 100);
  return { refundPaise, feePaise: paidPaise - refundPaise };
}

/**
 * Spreads a discount across lines in proportion to their totals, in whole paise, using
 * the largest-remainder method so the shares add up to the discount exactly.
 */
export function allocateDiscount(lineTotals: number[], discountPaise: number): number[] {
  const sum = lineTotals.reduce((a, b) => a + b, 0);
  if (sum === 0 || discountPaise === 0) return lineTotals.map(() => 0);
  const exact = lineTotals.map((t) => (t * discountPaise) / sum);
  const shares = exact.map(Math.floor);
  let left = discountPaise - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}

/**
 * What was actually paid for each line, in money: the line total minus its share of the
 * loyalty-points discount. Nothing is "paid" for an unpaid counter order. The scheduled
 * fee is never part of any line.
 */
export function paidPerLine(
  lines: { lineTotalPaise: number }[],
  order: { pointsDiscountPaise: number; paid: boolean },
): number[] {
  if (!order.paid) return lines.map(() => 0);
  const shares = allocateDiscount(
    lines.map((l) => l.lineTotalPaise),
    order.pointsDiscountPaise,
  );
  return lines.map((l, i) => l.lineTotalPaise - shares[i]!);
}
