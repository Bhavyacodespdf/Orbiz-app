import { randomUUID } from 'node:crypto';
import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { POINT_VALUE_PAISE, maxRedeemablePoints } from '../loyalty/loyalty.rules.js';
import { hasStockFor, inStock, stockStatus } from '../inventory/stock.js';

export const MAX_QUANTITY = 10;
export const MAX_DISTINCT_ITEMS = 20;

const cartInclude = {
  outlet: true,
  items: {
    include: { menuItem: { include: { category: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

export type CartIssueReason = 'SOLD_OUT' | 'NO_LONGER_ON_MENU' | 'NOT_ENOUGH_STOCK';

/** "Only 3 left" — when a counted item has fewer units than the cart wants. */
const notEnough = (name: string, available: number) =>
  new AppError(409, 'INSUFFICIENT_STOCK', `Only ${available} ${name} left.`, { available });

/**
 * The cart as the browser sees it. Prices are always read live from the menu;
 * the cart itself stores only item IDs and quantities.
 */
export async function getCartView(db: DbClient, userId: string) {
  const [cart, wallet] = await Promise.all([
    db.cart.findUnique({ where: { userId }, include: cartInclude }),
    db.wallet.findUnique({ where: { userId }, select: { pointsBalance: true } }),
  ]);
  const availablePoints = wallet?.pointsBalance ?? 0;
  /** What checkout would accept right now (checkout re-checks everything). */
  const loyalty = (subtotalPaise: number) => ({
    availablePoints,
    maxRedeemablePoints: maxRedeemablePoints(subtotalPaise, availablePoints),
    pointValuePaise: POINT_VALUE_PAISE,
  });
  if (!cart || cart.items.length === 0 || !cart.outlet) {
    return {
      outlet: null,
      items: [],
      itemCount: 0,
      subtotalPaise: 0,
      totalPaise: 0,
      issues: [],
      canCheckout: false,
      canSchedule: false,
      loyalty: loyalty(0),
    };
  }

  const issues: {
    menuItemId: string;
    name: string;
    reason: CartIssueReason;
    /** For NOT_ENOUGH_STOCK: how many can still be ordered. */
    available?: number;
  }[] = [];
  const items = cart.items.map(({ menuItem, quantity }) => {
    const onMenu =
      menuItem.isActive && menuItem.category.isActive && menuItem.outletId === cart.outletId;
    const orderable = onMenu && hasStockFor(menuItem, quantity);
    if (!orderable) {
      issues.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        reason: !onMenu ? 'NO_LONGER_ON_MENU' : inStock(menuItem) ? 'NOT_ENOUGH_STOCK' : 'SOLD_OUT',
        ...(onMenu && inStock(menuItem) && { available: menuItem.stockQuantity ?? 0 }),
      });
    }
    return {
      menuItemId: menuItem.id,
      name: menuItem.name,
      dietary: menuItem.dietary,
      unitPricePaise: menuItem.pricePaise,
      quantity,
      lineTotalPaise: menuItem.pricePaise * quantity,
      isOrderable: orderable,
      stockStatus: stockStatus(menuItem),
    };
  });

  const subtotalPaise = items.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  const acceptingOrders = cart.outlet.isActive && cart.outlet.status === 'OPEN';
  return {
    outlet: {
      id: cart.outlet.id,
      slug: cart.outlet.slug,
      name: cart.outlet.name,
      status: cart.outlet.status,
      acceptingOrders,
    },
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotalPaise,
    totalPaise: subtotalPaise, // no fees or taxes (decision Q7)
    issues,
    canCheckout: issues.length === 0 && acceptingOrders,
    /**
     * Could be placed as a scheduled order (for a later pickup slot), even while the outlet
     * is closed right now. A paused outlet takes no new orders at all. Slots are checked on
     * their own (GET /outlets/:slug/slots) and again at checkout.
     */
    canSchedule: issues.length === 0 && cart.outlet.isActive && cart.outlet.status !== 'PAUSED',
    loyalty: loyalty(subtotalPaise),
  };
}

export type CartView = Awaited<ReturnType<typeof getCartView>>;

/**
 * Creates the user's cart if it doesn't exist. A single INSERT … ON CONFLICT DO NOTHING,
 * so simultaneous first requests can't collide on the unique userId (an upsert can).
 */
async function ensureCart(tx: DbClient, userId: string) {
  await tx.$executeRaw`
    INSERT INTO "Cart" ("id", "userId", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    ON CONFLICT ("userId") DO NOTHING`;
}

/** Locks the user's cart row for the rest of the transaction (serialises cart changes and checkout). */
export async function lockCart(tx: DbClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "Cart" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
}

export async function addItem(
  db: Database,
  userId: string,
  input: { menuItemId: string; quantity: number; replaceCart: boolean },
) {
  await db.$transaction(async (tx) => {
    const menuItem = await tx.menuItem.findFirst({
      where: {
        id: input.menuItemId,
        isActive: true,
        category: { isActive: true },
        outlet: { isActive: true },
      },
      include: { outlet: true },
    });
    if (!menuItem) throw notFound('This item is not on the menu.');
    if (!inStock(menuItem)) {
      throw new AppError(409, 'ITEM_UNAVAILABLE', `${menuItem.name} is sold out right now.`);
    }
    if (menuItem.outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${menuItem.outlet.name} isn't taking orders right now.`,
      );
    }

    await ensureCart(tx, userId);
    await lockCart(tx, userId);
    const cart = await tx.cart.findUniqueOrThrow({
      where: { userId },
      include: { outlet: true, items: true },
    });

    if (cart.items.length > 0 && cart.outletId && cart.outletId !== menuItem.outletId) {
      if (!input.replaceCart) {
        throw new AppError(
          409,
          'CART_OUTLET_CONFLICT',
          `Your cart has items from ${cart.outlet?.name ?? 'another outlet'}. A cart can hold items from one outlet at a time.`,
          {
            currentOutlet: cart.outlet && {
              id: cart.outlet.id,
              name: cart.outlet.name,
              slug: cart.outlet.slug,
            },
            newOutlet: {
              id: menuItem.outlet.id,
              name: menuItem.outlet.name,
              slug: menuItem.outlet.slug,
            },
          },
        );
      }
      // The student explicitly chose to start a new cart.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      cart.items = [];
    }

    await tx.cart.update({ where: { id: cart.id }, data: { outletId: menuItem.outletId } });

    const existing = cart.items.find((i) => i.menuItemId === menuItem.id);
    const wanted = (existing?.quantity ?? 0) + input.quantity;
    if (!hasStockFor(menuItem, wanted)) throw notEnough(menuItem.name, menuItem.stockQuantity ?? 0);
    if (existing) {
      const quantity = existing.quantity + input.quantity;
      if (quantity > MAX_QUANTITY) {
        throw new AppError(
          409,
          'QUANTITY_LIMIT',
          `You can order up to ${MAX_QUANTITY} of each item.`,
        );
      }
      await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    } else {
      if (cart.items.length >= MAX_DISTINCT_ITEMS) {
        throw new AppError(
          409,
          'CART_FULL',
          `A cart can hold up to ${MAX_DISTINCT_ITEMS} different items.`,
        );
      }
      await tx.cartItem.create({
        data: { cartId: cart.id, menuItemId: menuItem.id, quantity: input.quantity },
      });
    }
  });
  return getCartView(db, userId);
}

export async function setQuantity(
  db: Database,
  userId: string,
  menuItemId: string,
  quantity: number,
) {
  const cart = await db.cart.findUnique({ where: { userId } });
  const line =
    cart &&
    (await db.cartItem.findUnique({
      where: { cartId_menuItemId: { cartId: cart.id, menuItemId } },
    }));
  if (!line) throw notFound('That item is not in your cart.');
  const menuItem = await db.menuItem.findUniqueOrThrow({ where: { id: menuItemId } });
  if (quantity > line.quantity && !hasStockFor(menuItem, quantity)) {
    throw notEnough(menuItem.name, menuItem.stockQuantity ?? 0);
  }
  await db.cartItem.update({ where: { id: line.id }, data: { quantity } });
  return getCartView(db, userId);
}

export async function removeItem(db: Database, userId: string, menuItemId: string) {
  await db.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({ where: { userId } });
    if (!cart) throw notFound('That item is not in your cart.');
    const { count } = await tx.cartItem.deleteMany({ where: { cartId: cart.id, menuItemId } });
    if (count === 0) throw notFound('That item is not in your cart.');
    if ((await tx.cartItem.count({ where: { cartId: cart.id } })) === 0) {
      await tx.cart.update({ where: { id: cart.id }, data: { outletId: null } });
    }
  });
  return getCartView(db, userId);
}

export async function clearCart(db: DbClient, userId: string) {
  const cart = await db.cart.findUnique({ where: { userId } });
  if (cart) {
    await db.cartItem.deleteMany({ where: { cartId: cart.id } });
    await db.cart.update({ where: { id: cart.id }, data: { outletId: null } });
  }
}

/**
 * Adds several dishes at once (a Surprise Meal combo) in ONE transaction: every dish is
 * re-checked against the live menu and the total against what the student saw, the usual
 * one-outlet rule applies, and nothing is added unless everything is valid. Repeating the
 * same idempotency key (double-click, retry) adds nothing more.
 */
export async function addCombo(
  db: Database,
  userId: string,
  input: {
    items: { menuItemId: string; quantity: number }[];
    expectedTotalPaise: number;
    replaceCart: boolean;
    idempotencyKey: string;
  },
) {
  const added = await db.$transaction(async (tx) => {
    const ids = input.items.map((i) => i.menuItemId);
    const menuItems = await tx.menuItem.findMany({
      where: { id: { in: ids } },
      include: { outlet: true, category: true },
    });
    const byId = new Map(menuItems.map((m) => [m.id, m]));
    const problems = input.items
      .map(({ menuItemId }) => byId.get(menuItemId) ?? { id: menuItemId, name: null })
      .filter(
        (m) =>
          !('isActive' in m) ||
          !m.isActive ||
          !inStock(m) ||
          !m.category.isActive ||
          !m.outlet.isActive,
      )
      .map((m) => ({ menuItemId: m.id, name: m.name }));
    if (problems.length > 0) {
      throw new AppError(
        409,
        'ITEMS_UNAVAILABLE',
        'Some dishes in this combo are no longer available.',
        { items: problems },
      );
    }
    const dishes = ids.map((id) => byId.get(id)!);
    const outlets = new Set(dishes.map((d) => d.outletId));
    if (outlets.size !== 1) {
      throw new AppError(400, 'MIXED_OUTLETS', 'A combo must come from one outlet.');
    }
    const outlet = dishes[0]!.outlet;
    if (outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${outlet.name} isn't taking orders right now.`,
      );
    }
    const totalPaise = input.items.reduce(
      (sum, { menuItemId, quantity }) => sum + byId.get(menuItemId)!.pricePaise * quantity,
      0,
    );
    if (totalPaise !== input.expectedTotalPaise) {
      throw new AppError(409, 'PRICE_CHANGED', 'Prices changed since this combo was made.', {
        totalPaise,
        items: dishes.map((d) => ({ menuItemId: d.id, pricePaise: d.pricePaise })),
      });
    }

    await ensureCart(tx, userId);
    await lockCart(tx, userId);
    const cart = await tx.cart.findUniqueOrThrow({
      where: { userId },
      include: { outlet: true, items: true },
    });
    // The same combo submitted again (after the first one committed): already added.
    if (cart.lastComboKey === input.idempotencyKey) return false;

    if (cart.items.length > 0 && cart.outletId && cart.outletId !== outlet.id) {
      if (!input.replaceCart) {
        throw new AppError(
          409,
          'CART_OUTLET_CONFLICT',
          `Your cart has items from ${cart.outlet?.name ?? 'another outlet'}. A cart can hold items from one outlet at a time.`,
          {
            currentOutlet: cart.outlet && {
              id: cart.outlet.id,
              name: cart.outlet.name,
              slug: cart.outlet.slug,
            },
            newOutlet: { id: outlet.id, name: outlet.name, slug: outlet.slug },
          },
        );
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      cart.items = [];
    }

    let distinct = cart.items.length;
    for (const { menuItemId, quantity } of input.items) {
      const existing = cart.items.find((i) => i.menuItemId === menuItemId);
      const dish = byId.get(menuItemId)!;
      if (!hasStockFor(dish, (existing?.quantity ?? 0) + quantity)) {
        throw notEnough(dish.name, dish.stockQuantity ?? 0);
      }
      if (existing) {
        if (existing.quantity + quantity > MAX_QUANTITY) {
          throw new AppError(
            409,
            'QUANTITY_LIMIT',
            `You can order up to ${MAX_QUANTITY} of each item.`,
          );
        }
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + quantity },
        });
      } else {
        distinct += 1;
        if (distinct > MAX_DISTINCT_ITEMS) {
          throw new AppError(
            409,
            'CART_FULL',
            `A cart can hold up to ${MAX_DISTINCT_ITEMS} different items.`,
          );
        }
        await tx.cartItem.create({ data: { cartId: cart.id, menuItemId, quantity } });
      }
    }
    await tx.cart.update({
      where: { id: cart.id },
      data: { outletId: outlet.id, lastComboKey: input.idempotencyKey },
    });
    return true;
  });
  return { cart: await getCartView(db, userId), added };
}
