import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ReorderSource } from '../../generated/prisma/enums.js';
import { inStock, inStockWhere, stockStatus } from '../inventory/stock.js';
import { addCombo, MAX_QUANTITY } from '../cart/cart.service.js';
import { NO_RATINGS, ratingSummaries, type RatingSummary } from '../reviews/ratings.js';
import {
  comboName,
  comboScore,
  daysBetween,
  explain,
  HISTORY_ORDER_LIMIT,
  HISTORY_WINDOW_DAYS,
  MAX_COMBO_LINES,
  MAX_SAVED_COMBOS,
  MAX_SUGGESTIONS,
  mineCandidates,
  POPULAR_MIN_STUDENTS,
  POPULAR_WINDOW_DAYS,
  previousMealLabel,
  type HistoryOrder,
} from './reorder.rules.js';

/*
 * Quick Reorder and favourite combos. Order records are the only source of purchase history;
 * prices, stock and availability always come from the live menu. Nothing here creates an order,
 * touches a wallet or reserves stock: dishes go into the existing cart (cart.service addCombo),
 * and the student checks out through the normal checkout, which re-checks everything and applies
 * the outlet's order-capacity limit.
 */

const DAY_MS = 86_400_000;

export type LineStatus =
  | 'AVAILABLE'
  /** Fewer units can be added than asked (stock left or the per-item cart limit). */
  | 'LIMITED'
  | 'SOLD_OUT'
  /** The dish (or its category) was removed from the menu. */
  | 'NO_LONGER_ON_MENU'
  /** The outlet is closed, paused or archived right now. */
  | 'OUTLET_UNAVAILABLE';

export interface LineInput {
  menuItemId: string;
  quantity: number;
  /** From the original order, for "was ₹40, now ₹45". Never used for pricing. */
  historicalUnitPricePaise?: number;
  /** The name on the old order (used if the dish no longer exists). */
  name?: string;
}

const menuInclude = { outlet: true, category: true } as const;
type MenuRow = Prisma.MenuItemGetPayload<{ include: typeof menuInclude }>;

async function loadMenu(db: DbClient, ids: string[]) {
  const rows = await db.menuItem.findMany({
    where: { id: { in: [...new Set(ids)] } },
    include: menuInclude,
  });
  return new Map(rows.map((r) => [r.id, r]));
}

const outletAccepting = (o: { isActive: boolean; status: string }) =>
  o.isActive && o.status === 'OPEN';

function statusOf(item: MenuRow | undefined, quantity: number) {
  if (!item || !item.isActive || !item.category.isActive) {
    return { status: 'NO_LONGER_ON_MENU' as LineStatus, addableQuantity: 0 };
  }
  if (!outletAccepting(item.outlet)) {
    return { status: 'OUTLET_UNAVAILABLE' as LineStatus, addableQuantity: 0 };
  }
  if (!inStock(item)) return { status: 'SOLD_OUT' as LineStatus, addableQuantity: 0 };
  const stockCap = item.trackInventory ? (item.stockQuantity ?? 0) : Infinity;
  const addableQuantity = Math.min(quantity, stockCap, MAX_QUANTITY);
  return addableQuantity < quantity
    ? {
        status: 'LIMITED' as LineStatus,
        addableQuantity,
        limitReason: stockCap < Math.min(quantity, MAX_QUANTITY) ? 'STOCK' : 'QUANTITY_LIMIT',
      }
    : { status: 'AVAILABLE' as LineStatus, addableQuantity };
}

type Alternative = {
  menuItemId: string;
  name: string;
  pricePaise: number;
  outlet: { id: string; name: string; slug: string };
};

/** Every line checked against the live menu, with current prices, totals and (optionally) alternatives. */
async function evaluate(
  db: DbClient,
  outletId: string,
  inputs: LineInput[],
  opts: {
    alternatives: boolean;
    menu?: Map<string, MenuRow>;
    ratings?: Map<string, RatingSummary>;
  },
) {
  const menu =
    opts.menu ??
    (await loadMenu(
      db,
      inputs.map((l) => l.menuItemId),
    ));
  const ratings =
    opts.ratings ??
    (await ratingSummaries(
      db,
      inputs.map((l) => l.menuItemId),
    ));
  const outlet =
    menu.get(inputs[0]?.menuItemId ?? '')?.outlet ??
    (await db.outlet.findUnique({ where: { id: outletId } }));

  const lines = inputs.map((input) => {
    const item = menu.get(input.menuItemId);
    const sameOutlet = item?.outletId === outletId;
    const state = statusOf(sameOutlet ? item : undefined, input.quantity);
    const current = sameOutlet && item?.isActive ? item.pricePaise : null;
    const historical = input.historicalUnitPricePaise ?? null;
    const r = ratings.get(input.menuItemId);
    return {
      menuItemId: input.menuItemId,
      name: item?.name ?? input.name ?? 'A dish that is no longer listed',
      imageUrl: item?.imageUrl ?? null,
      dietary: item?.dietary ?? null,
      categoryId: item?.categoryId ?? null,
      categoryName: item?.category.name ?? null,
      stockStatus: item ? stockStatus(item) : ('SOLD_OUT' as const),
      rating: r ? { average: r.average, count: r.count } : NO_RATINGS,
      requestedQuantity: input.quantity,
      ...state,
      historicalUnitPricePaise: historical,
      currentUnitPricePaise: current,
      priceChanged: historical !== null && current !== null && historical !== current,
      alternatives: [] as Alternative[],
      elsewhere: [] as Alternative[],
    };
  });

  if (opts.alternatives) {
    const takenIds = new Set(inputs.map((l) => l.menuItemId));
    for (const line of lines.filter((l) => l.addableQuantity === 0)) {
      // Same outlet, same category when we know it — offered, never substituted.
      if (outlet && outletAccepting(outlet)) {
        const alts = await db.menuItem.findMany({
          where: {
            outletId,
            isActive: true,
            category: { isActive: true },
            ...(line.categoryId && line.status !== 'NO_LONGER_ON_MENU'
              ? { categoryId: line.categoryId }
              : {}),
            id: { notIn: [...takenIds] },
            ...inStockWhere,
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          take: 3,
        });
        line.alternatives = alts.map((a) => ({
          menuItemId: a.id,
          name: a.name,
          pricePaise: a.pricePaise,
          outlet: { id: outlet.id, name: outlet.name, slug: outlet.slug },
        }));
      }
      // The same dish (by name) at another outlet that is open and has it in stock.
      const elsewhere = await db.menuItem.findMany({
        where: {
          name: { equals: line.name, mode: 'insensitive' },
          outletId: { not: outletId },
          isActive: true,
          category: { isActive: true },
          outlet: { isActive: true, status: 'OPEN' },
          ...inStockWhere,
        },
        include: { outlet: true },
        orderBy: { outlet: { name: 'asc' } },
        take: 3,
      });
      line.elsewhere = elsewhere.map((e) => ({
        menuItemId: e.id,
        name: e.name,
        pricePaise: e.pricePaise,
        outlet: { id: e.outlet.id, name: e.outlet.name, slug: e.outlet.slug },
      }));
    }
  }

  const addable = lines.filter((l) => l.addableQuantity > 0);
  const knownHistory = lines.every((l) => l.historicalUnitPricePaise !== null);
  return {
    outlet: outlet && {
      id: outlet.id,
      name: outlet.name,
      slug: outlet.slug,
      status: outlet.status,
      acceptingOrders: outletAccepting(outlet),
    },
    lines,
    addableCount: addable.length,
    /** Live prices × the quantities that can actually be added (no fees or taxes: decision Q7). */
    currentTotalPaise: addable.reduce(
      (s, l) => s + l.currentUnitPricePaise! * l.addableQuantity,
      0,
    ),
    historicalTotalPaise: knownHistory
      ? lines.reduce((s, l) => s + l.historicalUnitPricePaise! * l.requestedQuantity, 0)
      : null,
    /** Everything can be added exactly as before, at the same prices: safe for one tap. */
    unchanged: lines.every((l) => l.status === 'AVAILABLE' && !l.priceChanged),
  };
}

type HistoryRow = Prisma.OrderGetPayload<{ include: { items: true; outlet: true } }>;

/** The student's own collected orders in the history window (group orders excluded). */
async function recentOrders(db: DbClient, userId: string, now: Date): Promise<HistoryRow[]> {
  return db.order.findMany({
    where: {
      userId,
      status: 'COMPLETED',
      paymentMethod: { not: 'GROUP' },
      placedAt: { gte: new Date(now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS) },
    },
    include: { items: true, outlet: true },
    orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
    take: HISTORY_ORDER_LIMIT,
  });
}

const signature = (o: HistoryRow) =>
  `${o.outletId}|${o.items
    .map((i) => `${i.menuItemId}:${i.quantity}`)
    .sort()
    .join(',')}`;

/**
 * Quick Reorder cards: recent collected orders, newest first, with identical repeats folded into
 * one card that says how often it was ordered in the window. Older orders stay on /orders.
 */
export async function reorderHistory(
  db: Database,
  userId: string,
  { limit, now = new Date() }: { limit: number; now?: Date },
) {
  const orders = await recentOrders(db, userId, now);
  const seen = new Map<string, { order: HistoryRow; times: number }>();
  for (const o of orders) {
    const key = signature(o);
    const entry = seen.get(key);
    if (entry) entry.times += 1;
    else seen.set(key, { order: o, times: 1 });
  }
  const picked = [...seen.values()].slice(0, limit);
  const ids = picked.flatMap((p) => p.order.items.map((i) => i.menuItemId));
  const [menu, ratings] = await Promise.all([loadMenu(db, ids), ratingSummaries(db, ids)]);
  const cards = [];
  for (const { order, times } of picked) {
    const evaluated = await evaluate(
      db,
      order.outletId,
      order.items.map((i) => ({
        menuItemId: i.menuItemId,
        quantity: i.quantity,
        historicalUnitPricePaise: i.unitPricePaise,
        name: i.name,
      })),
      { alternatives: false, menu, ratings },
    );
    cards.push({
      orderId: order.id,
      label: previousMealLabel(order.placedAt),
      placedAt: order.placedAt.toISOString(),
      pickupCode: order.pickupCode,
      /** What the student paid for the food then (before any points discount). */
      previousTotalPaise: order.subtotalPaise,
      timesOrdered: times,
      ...evaluated,
      outlet: evaluated.outlet ?? {
        id: order.outlet.id,
        name: order.outlet.name,
        slug: order.outlet.slug,
        status: order.outlet.status,
        acceptingOrders: false,
      },
    });
  }
  return { windowDays: HISTORY_WINDOW_DAYS, orders: cards };
}

/**
 * "Your favourite combos": candidates mined from the student's own orders and ranked by
 * reorder.rules comboScore. With no repeat history, popular dishes from aggregate campus data
 * are returned instead, clearly marked as not personal.
 */
export async function favoriteCombos(
  db: Database,
  userId: string,
  { outletId, now = new Date() }: { outletId?: string; now?: Date },
) {
  const orders = await recentOrders(db, userId, now);
  const history: HistoryOrder[] = orders
    .filter((o) => !outletId || o.outletId === outletId)
    .map((o) => ({
      id: o.id,
      outletId: o.outletId,
      placedAt: o.placedAt,
      lines: o.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity })),
    }));
  const candidates = mineCandidates(history);
  const ids = candidates.flatMap((c) => c.lines.map((l) => l.menuItemId));
  const [menu, ratings] = await Promise.all([loadMenu(db, ids), ratingSummaries(db, ids)]);

  const scored = [];
  for (const c of candidates) {
    const evaluated = await evaluate(db, c.outletId, c.lines, {
      alternatives: false,
      menu,
      ratings,
    });
    if (evaluated.addableCount === 0) continue; // an unavailable combo is never suggested
    const score = comboScore({
      support: c.support,
      daysSinceLast: daysBetween(c.lastOrderedAt, now),
      itemFrequency: c.itemFrequency,
      availableShare: evaluated.addableCount / c.lines.length,
    });
    const usual = [
      c.usualMealTime &&
        `Usually ${c.usualMealTime === 'late-night' ? 'late at night' : `for ${c.usualMealTime}`}`,
      c.usualWeekday && `often on ${c.usualWeekday}`,
    ]
      .filter(Boolean)
      .join(', ');
    scored.push({
      key: c.key,
      kind: c.kind,
      name:
        c.kind === 'SINGLE'
          ? `Your usual ${c.lines[0]!.name}`
          : comboName(c.lines.map((l) => l.name)),
      explanation: explain(c),
      pattern: usual || null,
      timesOrdered: c.support,
      lastOrderedAt: c.lastOrderedAt.toISOString(),
      score: Math.round(score * 1000) / 1000,
      ...evaluated,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const combos = scored.slice(0, MAX_SUGGESTIONS);

  return {
    windowDays: HISTORY_WINDOW_DAYS,
    personalized: combos.length > 0,
    combos,
    popular: combos.length > 0 ? [] : await popularDishes(db, { outletId, now }),
  };
}

/**
 * Fallback for students without repeat history: dishes collected by the most different students
 * in the last 30 days. Aggregate only (a count of students, never who), and a dish needs at least
 * POPULAR_MIN_STUDENTS students to appear.
 */
export async function popularDishes(
  db: Database,
  { outletId, now = new Date() }: { outletId?: string; now?: Date },
) {
  const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ menuItemId: string; students: number }[]>`
    SELECT oi."menuItemId", COUNT(DISTINCT o."userId")::int AS students
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE o."status" = 'COMPLETED' AND o."placedAt" >= ${since}
    GROUP BY oi."menuItemId"
    HAVING COUNT(DISTINCT o."userId") >= ${POPULAR_MIN_STUDENTS}
    ORDER BY students DESC, oi."menuItemId" ASC
    LIMIT 40`;
  const menu = await loadMenu(
    db,
    rows.map((r) => r.menuItemId),
  );
  const ratings = await ratingSummaries(
    db,
    rows.map((r) => r.menuItemId),
  );
  const picks = [];
  for (const row of rows) {
    const item = menu.get(row.menuItemId);
    if (!item || (outletId && item.outletId !== outletId)) continue;
    const evaluated = await evaluate(db, item.outletId, [{ menuItemId: item.id, quantity: 1 }], {
      alternatives: false,
      menu,
      ratings,
    });
    if (evaluated.addableCount === 0) continue;
    picks.push({
      key: `POPULAR:${item.id}`,
      name: item.name,
      explanation: `Collected by ${row.students} students in the last ${POPULAR_WINDOW_DAYS} days`,
      students: row.students,
      ...evaluated,
    });
    if (picks.length >= MAX_SUGGESTIONS) break;
  }
  return picks;
}

// ─── Preview and add to cart ────────────────────────────────────────────────

export type PreviewSource =
  | { orderId: string }
  | { savedComboId: string }
  | { items: { menuItemId: string; quantity: number }[] };

/** The student's own collected (non-group) order, or 404 / 409. */
async function ownReorderableOrder(db: DbClient, userId: string, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    include: { items: { orderBy: { name: 'asc' } } },
  });
  if (!order) throw notFound('Order not found');
  if (order.paymentMethod === 'GROUP') {
    throw new AppError(
      409,
      'ORDER_NOT_REORDERABLE',
      'Group orders can’t be reordered here — start a new group tray instead.',
    );
  }
  if (order.status !== 'COMPLETED') {
    throw new AppError(
      409,
      'ORDER_NOT_REORDERABLE',
      'Only orders you collected can be reordered. You can still order these dishes from the menu.',
    );
  }
  return order;
}

async function ownSavedCombo(db: DbClient, userId: string, comboId: string) {
  const combo = await db.savedMealCombo.findFirst({
    where: { id: comboId, userId },
    include: { items: { include: { menuItem: true }, orderBy: { menuItem: { name: 'asc' } } } },
  });
  if (!combo) throw notFound('Saved combo not found');
  return combo;
}

/** All dishes must exist and come from one outlet; returns that outlet. */
async function outletOfItems(db: DbClient, items: { menuItemId: string }[]) {
  const rows = await db.menuItem.findMany({
    where: { id: { in: items.map((i) => i.menuItemId) } },
    select: { id: true, outletId: true },
  });
  if (rows.length !== new Set(items.map((i) => i.menuItemId)).size) {
    throw new AppError(404, 'NOT_FOUND', 'A dish in this combo doesn’t exist.');
  }
  const outlets = new Set(rows.map((r) => r.outletId));
  if (outlets.size !== 1) {
    throw new AppError(400, 'MIXED_OUTLETS', 'A combo must come from one outlet.');
  }
  return rows[0]!.outletId;
}

/** What a reorder would put in the cart right now, line by line. Read-only. */
export async function previewReorder(db: Database, userId: string, source: PreviewSource) {
  if ('orderId' in source) {
    const order = await ownReorderableOrder(db, userId, source.orderId);
    return {
      source: { type: 'ORDER' as const, orderId: order.id },
      ...(await evaluate(
        db,
        order.outletId,
        order.items.map((i) => ({
          menuItemId: i.menuItemId,
          quantity: i.quantity,
          historicalUnitPricePaise: i.unitPricePaise,
          name: i.name,
        })),
        { alternatives: true },
      )),
    };
  }
  if ('savedComboId' in source) {
    const combo = await ownSavedCombo(db, userId, source.savedComboId);
    return {
      source: { type: 'SAVED_COMBO' as const, savedComboId: combo.id },
      ...(await evaluate(
        db,
        combo.outletId,
        combo.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
        { alternatives: true },
      )),
    };
  }
  const outletId = await outletOfItems(db, source.items);
  return {
    source: null,
    ...(await evaluate(db, outletId, source.items, { alternatives: true })),
  };
}

export type ReorderSourceInput =
  | { type: 'ORDER'; orderId: string }
  | { type: 'SAVED_COMBO'; savedComboId: string }
  | { type: 'SUGGESTED_COMBO' }
  | { type: 'POPULAR' };

/**
 * Puts the chosen dishes in the student's cart through the existing cart service (addCombo):
 * live prices must still add up to what the student reviewed, every dish is re-checked, the
 * one-outlet cart rule applies, and a retried request (same Idempotency-Key) adds nothing more.
 * Records one ReorderEvent per successful add.
 */
export async function reorderIntoCart(
  db: Database,
  userId: string,
  input: {
    items: { menuItemId: string; quantity: number }[];
    expectedTotalPaise: number;
    replaceCart: boolean;
    idempotencyKey: string;
    source: ReorderSourceInput;
  },
) {
  // The source must be the student's own; another student's order or combo is just "not found".
  if (input.source.type === 'ORDER') await ownReorderableOrder(db, userId, input.source.orderId);
  if (input.source.type === 'SAVED_COMBO') {
    await ownSavedCombo(db, userId, input.source.savedComboId);
  }
  const outletId = await outletOfItems(db, input.items);
  const { cart, added } = await addCombo(db, userId, {
    items: input.items,
    expectedTotalPaise: input.expectedTotalPaise,
    replaceCart: input.replaceCart,
    idempotencyKey: input.idempotencyKey,
  });
  if (added) {
    await db.reorderEvent.createMany({
      data: [
        {
          userId,
          source: input.source.type as ReorderSource,
          orderId: input.source.type === 'ORDER' ? input.source.orderId : null,
          savedComboId: input.source.type === 'SAVED_COMBO' ? input.source.savedComboId : null,
          outletId,
          itemCount: input.items.reduce((s, i) => s + i.quantity, 0),
          totalPaise: input.expectedTotalPaise,
          idempotencyKey: input.idempotencyKey,
        },
      ],
      skipDuplicates: true,
    });
  }
  return { cart, added };
}

// ─── Saved combos ───────────────────────────────────────────────────────────

export async function listSavedCombos(db: Database, userId: string) {
  const combos = await db.savedMealCombo.findMany({
    where: { userId },
    include: { items: { include: { menuItem: true }, orderBy: { menuItem: { name: 'asc' } } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });
  const ids = combos.flatMap((c) => c.items.map((i) => i.menuItemId));
  const [menu, ratings] = await Promise.all([loadMenu(db, ids), ratingSummaries(db, ids)]);
  const out = [];
  for (const c of combos) {
    out.push({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      ...(await evaluate(
        db,
        c.outletId,
        c.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
        { alternatives: false, menu, ratings },
      )),
    });
  }
  return out;
}

/** Saved dishes must be on the outlet's menu now (they may be sold out today). */
async function checkComboItems(db: DbClient, items: { menuItemId: string; quantity: number }[]) {
  const outletId = await outletOfItems(db, items);
  const gone = await db.menuItem.findMany({
    where: {
      id: { in: items.map((i) => i.menuItemId) },
      OR: [{ isActive: false }, { category: { isActive: false } }, { outlet: { isActive: false } }],
    },
    select: { name: true },
  });
  if (gone.length > 0) {
    throw new AppError(
      409,
      'ITEMS_UNAVAILABLE',
      `${gone.map((g) => g.name).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer on the menu.`,
    );
  }
  return outletId;
}

const nameTaken = () =>
  new AppError(409, 'COMBO_NAME_TAKEN', 'You already have a saved combo with that name.');

export async function createSavedCombo(
  db: Database,
  userId: string,
  input: { name: string; items: { menuItemId: string; quantity: number }[] },
) {
  const outletId = await checkComboItems(db, input.items);
  if ((await db.savedMealCombo.count({ where: { userId } })) >= MAX_SAVED_COMBOS) {
    throw new AppError(
      409,
      'TOO_MANY_COMBOS',
      `You can save up to ${MAX_SAVED_COMBOS} combos. Delete one to save another.`,
    );
  }
  try {
    const combo = await db.$transaction(async (tx) => {
      const created = await tx.savedMealCombo.create({
        data: { userId, outletId, name: input.name },
      });
      await tx.savedMealComboItem.createMany({
        data: input.items.map((i) => ({
          comboId: created.id,
          menuItemId: i.menuItemId,
          outletId,
          quantity: i.quantity,
        })),
      });
      return created;
    });
    return combo.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateSavedCombo(
  db: Database,
  userId: string,
  comboId: string,
  input: { name?: string; items?: { menuItemId: string; quantity: number }[] },
) {
  await ownSavedCombo(db, userId, comboId);
  const outletId = input.items ? await checkComboItems(db, input.items) : undefined;
  try {
    await db.$transaction(async (tx) => {
      if (input.items) {
        await tx.savedMealComboItem.deleteMany({ where: { comboId } });
        // Moving a combo to another outlet: update the combo first so the item FK matches.
        await tx.savedMealCombo.update({
          where: { id: comboId },
          data: { outletId, ...(input.name && { name: input.name }) },
        });
        await tx.savedMealComboItem.createMany({
          data: input.items.map((i) => ({
            comboId,
            menuItemId: i.menuItemId,
            outletId: outletId!,
            quantity: i.quantity,
          })),
        });
      } else if (input.name) {
        await tx.savedMealCombo.update({ where: { id: comboId }, data: { name: input.name } });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function deleteSavedCombo(db: Database, userId: string, comboId: string) {
  await ownSavedCombo(db, userId, comboId);
  await db.savedMealCombo.delete({ where: { id: comboId } });
}

export { MAX_COMBO_LINES };
