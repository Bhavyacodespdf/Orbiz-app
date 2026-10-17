import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { MenuCategory, MenuItem } from '../../generated/prisma/client.js';
import type { StaffRole, StockAdjustmentType } from '../../generated/prisma/enums.js';
import { MAX_STOCK, stockStatus, soldOutReason, type StockStatus } from './stock.js';

/*
 * Stock changes. Every quantity change is ONE conditional UPDATE on the item row
 * (PostgreSQL locks the row), so two changes at once can never overwrite each other or
 * take stock below zero, and each writes a StockAdjustment row in the same transaction.
 */

export interface Actor {
  userId: string;
  role: StaffRole | 'STUDENT';
}

type ItemWithCategory = MenuItem & { category: MenuCategory };

export function toInventoryItem(item: ItemWithCategory) {
  return {
    id: item.id,
    name: item.name,
    imageUrl: item.imageUrl,
    pricePaise: item.pricePaise,
    dietary: item.dietary,
    isActive: item.isActive,
    category: { id: item.category.id, name: item.category.name, isActive: item.category.isActive },
    trackInventory: item.trackInventory,
    stockQuantity: item.stockQuantity,
    lowStockThreshold: item.lowStockThreshold,
    soldOutManually: !item.isAvailable,
    stockStatus: stockStatus(item),
    soldOutReason: soldOutReason(item),
    stockUpdatedAt: item.stockUpdatedAt,
    updatedAt: item.updatedAt,
  };
}
export type InventoryItem = ReturnType<typeof toInventoryItem>;

const utcNow = () => new Date();

async function loadItem(db: DbClient, outletId: string, itemId: string) {
  const item = await db.menuItem.findFirst({
    where: { id: itemId, outletId },
    include: { category: true },
  });
  if (!item) throw notFound('Menu item not found');
  return item;
}

async function logAdjustment(
  tx: DbClient,
  data: {
    item: { id: string; outletId: string };
    type: StockAdjustmentType;
    quantityChange?: number;
    previousQuantity?: number | null;
    resultingQuantity?: number | null;
    orderId?: string;
    actor: Actor | null;
    reason?: string | null;
    planItemId?: string;
    idempotencyKey?: string;
  },
) {
  await tx.stockAdjustment.create({
    data: {
      menuItemId: data.item.id,
      outletId: data.item.outletId,
      type: data.type,
      quantityChange: data.quantityChange ?? 0,
      previousQuantity: data.previousQuantity ?? null,
      resultingQuantity: data.resultingQuantity ?? null,
      orderId: data.orderId,
      actorUserId: data.actor?.userId ?? null,
      actorRole: data.actor?.role ?? null,
      reason: data.reason ?? null,
      planItemId: data.planItemId ?? null,
      idempotencyKey: data.idempotencyKey ?? null,
    },
  });
}

const notTracked = () =>
  new AppError(409, 'NOT_TRACKED', 'Turn on quantity tracking for this item first.');

// ─── Staff operations ────────────────────────────────────────────────────────

export interface InventoryFilters {
  q?: string;
  categoryId?: string;
  status?: StockStatus;
}

export async function listInventory(db: Database, outletId: string, filters: InventoryFilters) {
  const rows = await db.menuItem.findMany({
    where: {
      outletId,
      isActive: true,
      ...(filters.categoryId && { categoryId: filters.categoryId }),
      ...(filters.q && { name: { contains: filters.q, mode: 'insensitive' } }),
    },
    include: { category: true },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    take: 500,
  });
  const all = rows.map(toInventoryItem);
  const counts = { AVAILABLE: 0, LOW_STOCK: 0, SOLD_OUT: 0 } satisfies Record<StockStatus, number>;
  for (const item of all) counts[item.stockStatus] += 1;
  return {
    items: filters.status ? all.filter((i) => i.stockStatus === filters.status) : all,
    counts,
  };
}

export type AdjustmentInput =
  | { type: 'RESTOCK'; quantity: number; reason?: string; markAvailable?: boolean }
  | { type: 'REMOVAL'; quantity: number; reason: string }
  | { type: 'COUNT_SET'; quantity: number; expectedQuantity: number; reason?: string };

/** Links a restock to a weekly stock plan line (with the client's retry key). */
export interface PlanLink {
  planItemId: string;
  idempotencyKey: string;
}

/** Restock, remove (waste/correction) or set a counted quantity. */
export async function adjustStock(
  db: Database,
  params: { outletId: string; itemId: string; input: AdjustmentInput; actor: Actor },
) {
  return db.$transaction((tx) => adjustStockTx(tx, params));
}

/** The same, inside a caller's transaction (the stock planner records restocks this way). */
export async function adjustStockTx(
  tx: DbClient,
  params: {
    outletId: string;
    itemId: string;
    input: AdjustmentInput;
    actor: Actor;
    planLink?: PlanLink;
  },
) {
  const { outletId, itemId, input, actor, planLink } = params;
  if (input.type === 'COUNT_SET' && actor.role !== 'MANAGER') {
    throw forbidden('Only a manager can replace the recorded quantity with a stock count.');
  }
  if (planLink && input.type !== 'RESTOCK') {
    throw new AppError(400, 'INVALID_PLAN_LINK', 'Only restocks can be linked to a stock plan.');
  }

  const before = await loadItem(tx, outletId, itemId);
  if (!before.trackInventory) throw notTracked();

  let rows: { stockQuantity: number }[];
  if (input.type === 'RESTOCK') {
    rows = await tx.$queryRaw`
      UPDATE "MenuItem"
      SET "stockQuantity" = "stockQuantity" + ${input.quantity},
          "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = ${itemId}::uuid AND "trackInventory" AND "stockQuantity" + ${input.quantity} <= ${MAX_STOCK}
      RETURNING "stockQuantity"`;
    if (rows.length === 0) {
      throw new AppError(400, 'STOCK_LIMIT', `An item can hold at most ${MAX_STOCK} units.`);
    }
  } else if (input.type === 'REMOVAL') {
    rows = await tx.$queryRaw`
      UPDATE "MenuItem"
      SET "stockQuantity" = "stockQuantity" - ${input.quantity},
          "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = ${itemId}::uuid AND "trackInventory" AND "stockQuantity" >= ${input.quantity}
      RETURNING "stockQuantity"`;
    if (rows.length === 0) {
      const current = await tx.menuItem.findUniqueOrThrow({ where: { id: itemId } });
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${current.stockQuantity ?? 0} in stock.`,
        {
          stockQuantity: current.stockQuantity,
        },
      );
    }
  } else {
    // Only applies if nobody changed the quantity since the counter looked at it.
    rows = await tx.$queryRaw`
      UPDATE "MenuItem"
      SET "stockQuantity" = ${input.quantity},
          "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = ${itemId}::uuid AND "trackInventory" AND "stockQuantity" = ${input.expectedQuantity}
      RETURNING "stockQuantity"`;
    if (rows.length === 0) {
      const current = await tx.menuItem.findUniqueOrThrow({ where: { id: itemId } });
      throw new AppError(
        409,
        'STOCK_CHANGED',
        'The quantity changed while you were counting. Check the new figure and try again.',
        { stockQuantity: current.stockQuantity },
      );
    }
  }

  // The quantity before THIS change (another change may have committed in between).
  const resulting = rows[0]!.stockQuantity;
  const previous =
    input.type === 'RESTOCK'
      ? resulting - input.quantity
      : input.type === 'REMOVAL'
        ? resulting + input.quantity
        : input.expectedQuantity;
  await logAdjustment(tx, {
    item: before,
    type: input.type,
    quantityChange: resulting - previous,
    previousQuantity: previous,
    resultingQuantity: resulting,
    actor,
    reason: input.reason?.trim() || null,
    ...planLink,
  });

  if (input.type === 'RESTOCK' && input.markAvailable && !before.isAvailable) {
    await tx.menuItem.update({ where: { id: itemId }, data: { isAvailable: true } });
    await logAdjustment(tx, {
      item: before,
      type: 'MARKED_AVAILABLE',
      actor,
      reason: 'Restocked',
    });
  }
  return toInventoryItem(await loadItem(tx, outletId, itemId));
}

/** Manager: the quantity at or below which the item shows as LOW STOCK. */
export async function setThreshold(
  db: Database,
  params: { outletId: string; itemId: string; lowStockThreshold: number; actor: Actor },
) {
  return db.$transaction(async (tx) => {
    const before = await loadItem(tx, params.outletId, params.itemId);
    if (before.lowStockThreshold === params.lowStockThreshold) return toInventoryItem(before);
    await tx.menuItem.update({
      where: { id: before.id },
      data: { lowStockThreshold: params.lowStockThreshold },
    });
    await logAdjustment(tx, {
      item: before,
      type: 'THRESHOLD_CHANGED',
      actor: params.actor,
      reason: `Low-stock threshold ${before.lowStockThreshold} → ${params.lowStockThreshold}`,
    });
    return toInventoryItem(await loadItem(tx, params.outletId, params.itemId));
  });
}

/**
 * Manager: start or stop counting units for an item. Starting needs a real, counted
 * starting quantity — nothing is ever assumed.
 */
export async function setTracking(
  db: Database,
  params: {
    outletId: string;
    itemId: string;
    enabled: boolean;
    quantity?: number;
    lowStockThreshold?: number;
    actor: Actor;
  },
) {
  return db.$transaction(async (tx) => {
    const before = await loadItem(tx, params.outletId, params.itemId);
    if (params.enabled) {
      if (params.quantity === undefined) {
        throw new AppError(400, 'QUANTITY_REQUIRED', 'Enter the quantity you have on hand.');
      }
      const { count } = await tx.menuItem.updateMany({
        where: { id: before.id, trackInventory: false },
        data: {
          trackInventory: true,
          stockQuantity: params.quantity,
          stockUpdatedAt: utcNow(),
          ...(params.lowStockThreshold !== undefined && {
            lowStockThreshold: params.lowStockThreshold,
          }),
        },
      });
      if (count === 0) throw new AppError(409, 'ALREADY_TRACKED', 'This item is already tracked.');
      await logAdjustment(tx, {
        item: before,
        type: 'TRACKING_ENABLED',
        quantityChange: params.quantity,
        previousQuantity: null,
        resultingQuantity: params.quantity,
        actor: params.actor,
        reason: 'Started counting stock',
      });
    } else {
      const { count } = await tx.menuItem.updateMany({
        where: { id: before.id, trackInventory: true },
        data: { trackInventory: false, stockQuantity: null, stockUpdatedAt: utcNow() },
      });
      if (count === 0) throw notTracked();
      await logAdjustment(tx, {
        item: before,
        type: 'TRACKING_DISABLED',
        previousQuantity: before.stockQuantity,
        actor: params.actor,
        reason: 'Stopped counting stock',
      });
    }
    await recordAudit(tx, {
      actor: { type: 'USER', userId: params.actor.userId },
      action: params.enabled ? 'STOCK_TRACKING_ENABLED' : 'STOCK_TRACKING_DISABLED',
      entityType: 'MenuItem',
      entityId: before.id,
      metadata: { outletId: params.outletId, quantity: params.quantity ?? null },
    });
    return toInventoryItem(await loadItem(tx, params.outletId, params.itemId));
  });
}

/**
 * Marks an item sold out (an explicit override that stays until staff restore it) or
 * restores it. Restoring a tracked item with 0 left still shows it sold out until restocked.
 */
export async function setSoldOut(
  db: Database,
  params: { outletId: string; itemId: string; soldOut: boolean; actor: Actor; reason?: string },
) {
  return db.$transaction(async (tx) => {
    const before = await loadItem(tx, params.outletId, params.itemId);
    const { count } = await tx.menuItem.updateMany({
      where: { id: before.id, isAvailable: params.soldOut },
      data: { isAvailable: !params.soldOut },
    });
    if (count === 1) {
      await logAdjustment(tx, {
        item: before,
        type: params.soldOut ? 'MARKED_SOLD_OUT' : 'MARKED_AVAILABLE',
        previousQuantity: before.stockQuantity,
        resultingQuantity: before.stockQuantity,
        actor: params.actor,
        reason: params.reason?.trim() || null,
      });
    }
    return toInventoryItem(await loadItem(tx, params.outletId, params.itemId));
  });
}

export async function stockHistory(db: Database, outletId: string, itemId: string) {
  await loadItem(db, outletId, itemId);
  const rows = await db.stockAdjustment.findMany({
    where: { menuItemId: itemId, outletId },
    include: { actor: { select: { displayName: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    quantityChange: r.quantityChange,
    previousQuantity: r.previousQuantity,
    resultingQuantity: r.resultingQuantity,
    orderId: r.orderId,
    actor: r.actor ? { displayName: r.actor.displayName, role: r.actorRole } : null,
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/**
 * Takes stock for a new order inside the checkout transaction. Each tracked line is a
 * conditional decrement, so concurrent orders can never oversell: the second one waits
 * for the row lock and then sees the reduced quantity. Lines are processed in a fixed
 * order (by item id) so two multi-item orders can't deadlock. Throws INSUFFICIENT_STOCK,
 * rolling back the whole checkout, if any line can't be covered.
 */
export async function deductForOrder(
  tx: DbClient,
  params: {
    orderId: string;
    lines: { menuItemId: string; name: string; quantity: number }[];
    items: { id: string; outletId: string; trackInventory: boolean }[];
    actor: Actor;
  },
) {
  const tracked = new Map(params.items.filter((i) => i.trackInventory).map((i) => [i.id, i]));
  const lines = params.lines
    .filter((l) => tracked.has(l.menuItemId))
    .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  const short: { menuItemId: string; name: string; available: number; requested: number }[] = [];
  for (const line of lines) {
    const rows = await tx.$queryRaw<{ stockQuantity: number }[]>`
      UPDATE "MenuItem"
      SET "stockQuantity" = "stockQuantity" - ${line.quantity},
          "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = ${line.menuItemId}::uuid AND "trackInventory" AND "stockQuantity" >= ${line.quantity}
      RETURNING "stockQuantity"`;
    if (rows.length === 0) {
      const current = await tx.menuItem.findUniqueOrThrow({ where: { id: line.menuItemId } });
      short.push({
        menuItemId: line.menuItemId,
        name: line.name,
        available: current.stockQuantity ?? 0,
        requested: line.quantity,
      });
      continue;
    }
    const resulting = rows[0]!.stockQuantity;
    await logAdjustment(tx, {
      item: tracked.get(line.menuItemId)!,
      type: 'ORDER_DEDUCTION',
      quantityChange: -line.quantity,
      previousQuantity: resulting + line.quantity,
      resultingQuantity: resulting,
      orderId: params.orderId,
      actor: params.actor,
    });
  }
  if (short.length > 0) {
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      short.length === 1
        ? `Only ${short[0]!.available} ${short[0]!.name} left.`
        : 'Some items don’t have enough stock left.',
      { items: short },
    );
  }
}

/**
 * Gives back exactly what an order took, once: only items that were actually deducted,
 * and unique(orderId, menuItemId, type) makes a second restoration impossible.
 * Returns the item ids that changed.
 */
export async function restoreForOrder(
  tx: DbClient,
  params: { orderId: string; actor: Actor; reason: string },
): Promise<string[]> {
  const deductions = await tx.stockAdjustment.findMany({
    where: { orderId: params.orderId, type: 'ORDER_DEDUCTION' },
  });
  const restored = await tx.stockAdjustment.findMany({
    where: { orderId: params.orderId, type: 'ORDER_RESTORE' },
    select: { menuItemId: true },
  });
  const done = new Set(restored.map((r) => r.menuItemId));
  const changed: string[] = [];
  for (const d of deductions) {
    if (done.has(d.menuItemId)) continue;
    const quantity = -d.quantityChange;
    const rows = await tx.$queryRaw<{ stockQuantity: number }[]>`
      UPDATE "MenuItem"
      SET "stockQuantity" = LEAST("stockQuantity" + ${quantity}, ${MAX_STOCK}),
          "stockUpdatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = ${d.menuItemId}::uuid AND "trackInventory"
      RETURNING "stockQuantity"`;
    const resulting = rows[0]?.stockQuantity ?? null;
    await logAdjustment(tx, {
      item: { id: d.menuItemId, outletId: d.outletId },
      type: 'ORDER_RESTORE',
      // If tracking was switched off meanwhile there is no quantity to give back.
      quantityChange: resulting === null ? 0 : quantity,
      previousQuantity: resulting === null ? null : resulting - quantity,
      resultingQuantity: resulting,
      orderId: params.orderId,
      actor: params.actor,
      reason: resulting === null ? `${params.reason} (item no longer tracked)` : params.reason,
    });
    changed.push(d.menuItemId);
  }
  return changed;
}
