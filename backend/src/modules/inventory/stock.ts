import type { Prisma } from '../../generated/prisma/client.js';

/*
 * The single definition of a menu item's stock status, used by every part of
 * CampusCart (menus, cart, checkout, Today's Special, Surprise Meal, staff screens).
 *
 *   marked sold out by staff (isAvailable = false)  → SOLD_OUT   (stays until staff restore it)
 *   tracked and quantity <= 0                         → SOLD_OUT
 *   tracked and 0 < quantity <= lowStockThreshold     → LOW_STOCK  (still orderable)
 *   otherwise                                         → AVAILABLE
 *
 * The status is always derived from these fields, never stored, so it can't drift.
 */

export const STOCK_STATUSES = ['AVAILABLE', 'LOW_STOCK', 'SOLD_OUT'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Largest quantity a tracked item may hold (database CHECK). */
export const MAX_STOCK = 100_000;
export const MAX_THRESHOLD = 10_000;

export interface StockFields {
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity: number | null;
  lowStockThreshold: number;
}

export function stockStatus(item: StockFields): StockStatus {
  if (!item.isAvailable) return 'SOLD_OUT';
  if (!item.trackInventory) return 'AVAILABLE';
  const quantity = item.stockQuantity ?? 0;
  if (quantity <= 0) return 'SOLD_OUT';
  return quantity <= item.lowStockThreshold ? 'LOW_STOCK' : 'AVAILABLE';
}

/** Why an item is sold out, when it is. */
export function soldOutReason(item: StockFields): 'MARKED_SOLD_OUT' | 'OUT_OF_STOCK' | null {
  if (!item.isAvailable) return 'MARKED_SOLD_OUT';
  if (item.trackInventory && (item.stockQuantity ?? 0) <= 0) return 'OUT_OF_STOCK';
  return null;
}

export const inStock = (item: StockFields) => stockStatus(item) !== 'SOLD_OUT';

/** Enough units for this quantity (untracked items are unlimited). */
export const hasStockFor = (item: StockFields, quantity: number) =>
  inStock(item) && (!item.trackInventory || (item.stockQuantity ?? 0) >= quantity);

/**
 * Prisma filter for "not sold out". Wrapped in AND so callers can combine it with
 * their own OR conditions without one replacing the other.
 */
export const inStockWhere: Prisma.MenuItemWhereInput = {
  AND: [{ isAvailable: true }, { OR: [{ trackInventory: false }, { stockQuantity: { gt: 0 } }] }],
};
