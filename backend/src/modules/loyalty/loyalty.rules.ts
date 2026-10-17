/*
 * Wallet recharge and loyalty-point business rules. This is the ONLY place these
 * numbers live: the API sends them to the app for previews, and every route and
 * service uses these functions.
 */

/** Smallest recharge allowed (₹99). Configuration can raise it, never lower it. */
export const RECHARGE_MIN_PAISE = 9_900;

/** 1 loyalty point is worth exactly ₹1 off an order. */
export const POINT_VALUE_PAISE = 100;

/** At least this much of an order is always paid with money, never with points (₹1). */
export const MIN_PAYABLE_AFTER_POINTS_PAISE = 100;

/**
 * Bonus points for a successful recharge of EXACTLY one of these amounts. Any other
 * amount earns nothing: there is no rounding and no "nearest slab".
 */
export const RECHARGE_BONUS_SLABS: readonly { amountPaise: number; points: number }[] = [
  { amountPaise: 50_000, points: 10 },
  { amountPaise: 100_000, points: 25 },
  { amountPaise: 130_000, points: 30 },
  { amountPaise: 150_000, points: 40 },
];

export function bonusPointsFor(amountPaise: number): number {
  return RECHARGE_BONUS_SLABS.find((slab) => slab.amountPaise === amountPaise)?.points ?? 0;
}

/** The effective minimum recharge: ₹99, or a higher configured minimum. */
export const rechargeMinPaise = (configuredMinPaise: number) =>
  Math.max(RECHARGE_MIN_PAISE, configuredMinPaise);

/** Rupee discount for a number of points. */
export const pointsToPaise = (points: number) => points * POINT_VALUE_PAISE;

/**
 * Most points usable on an order: whole rupees of the order amount, always leaving
 * at least ₹1 to pay, and never more than the student has. Orders have no taxes or
 * fees, so the whole subtotal is eligible.
 */
export function maxRedeemablePoints(eligiblePaise: number, availablePoints: number): number {
  const coverable = Math.floor(
    (eligiblePaise - MIN_PAYABLE_AFTER_POINTS_PAISE) / POINT_VALUE_PAISE,
  );
  return Math.max(0, Math.min(availablePoints, coverable));
}
