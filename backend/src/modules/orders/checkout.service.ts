import type { Database } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import type { PaymentMethod } from '../../generated/prisma/enums.js';
import { lockCart } from '../cart/cart.service.js';
import { debitBalance, ensureWallet } from '../wallet/wallet.service.js';
import { formatPickupCode, istDay, nextPickupNumber } from './pickup.js';
import { redeemForOrder } from '../loyalty/loyalty.service.js';
import { deductForOrder } from '../inventory/inventory.service.js';
import { inStock } from '../inventory/stock.js';
import { assertSlotBookable, loadOutletWithHours } from '../scheduling/scheduling.service.js';
import { feeFor } from '../scheduling/scheduling.rules.js';
import { notify } from '../notifications/notifications.service.js';
import { placedNotice } from '../notifications/order-notices.js';
import { maxRedeemablePoints, pointsToPaise } from '../loyalty/loyalty.rules.js';
import { orderInclude, toOrder } from './orders.serializer.js';
import { claimOrderCapacity } from '../capacity/capacity.service.js';
import { ORDER_CAPACITY_PER_WINDOW } from '../capacity/capacity.rules.js';

export interface CheckoutInput {
  userId: string;
  paymentMethod: PaymentMethod;
  /** The total the student saw. If prices changed since, checkout stops and asks them to confirm. */
  expectedTotalPaise: number;
  /** Loyalty points to spend on this order (1 point = ₹1). */
  pointsToRedeem?: number;
  /** A pickup slot start for a scheduled order; absent/null = order now (the original flow). */
  scheduledFor?: Date | null;
  idempotencyKey: string;
  /** Orders per outlet per rolling window. Only end-to-end test setups change it (see env.ts). */
  capacityLimit?: number;
}

async function findByKey(db: Database, userId: string, idempotencyKey: string) {
  const order = await db.order.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: orderInclude,
  });
  return order && toOrder(order);
}

/**
 * Turns the student's cart into an order in ONE database transaction:
 * re-validate everything → price on the server → take a pickup number →
 * create the order → (wallet) debit atomically → empty the cart.
 * If any step fails, nothing is saved: no order, no debit, cart unchanged.
 */
export async function checkout(db: Database, input: CheckoutInput) {
  const { userId, paymentMethod, expectedTotalPaise, idempotencyKey } = input;
  const pointsToRedeem = input.pointsToRedeem ?? 0;
  const scheduledFor = input.scheduledFor ?? null;
  const timing = scheduledFor ? 'SCHEDULED' : 'IMMEDIATE';

  // Retried request (double-click, network retry): return the order already placed.
  const previous = await findByKey(db, userId, idempotencyKey);
  if (previous) return { order: previous, created: false };

  try {
    const outcome = await db.$transaction(async (tx) => {
      // Serialise checkouts of this cart: a second concurrent attempt waits here.
      await lockCart(tx, userId);
      // If it duplicates the request that just finished, return that order
      // rather than reporting the (now empty) cart.
      const duplicate = await tx.order.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: { id: true },
      });
      if (duplicate) return { orderId: duplicate.id, created: false };

      const cart = await tx.cart.findUnique({
        where: { userId },
        include: {
          outlet: true,
          items: { include: { menuItem: { include: { category: true } } } },
        },
      });
      if (!cart || cart.items.length === 0 || !cart.outlet) {
        throw new AppError(409, 'CART_EMPTY', 'Your cart is empty.');
      }
      const outlet = cart.outlet;
      if (scheduledFor) {
        // A slot inside the outlet's pickup hours, far enough ahead, not full. The outlet
        // may be closed right now; only "paused" (no new orders) blocks scheduling.
        await assertSlotBookable(
          tx,
          await loadOutletWithHours(tx, { id: outlet.id }),
          scheduledFor,
        );
      } else if (!outlet.isActive || outlet.status !== 'OPEN') {
        throw new AppError(
          409,
          'OUTLET_NOT_ACCEPTING',
          `${outlet.name} isn't taking orders right now.`,
        );
      }

      const problems = cart.items
        .filter(
          ({ menuItem }) =>
            !menuItem.isActive ||
            !menuItem.category.isActive ||
            !inStock(menuItem) ||
            menuItem.outletId !== outlet.id,
        )
        .map(({ menuItem }) => ({ menuItemId: menuItem.id, name: menuItem.name }));
      if (problems.length > 0) {
        throw new AppError(
          409,
          'ITEMS_UNAVAILABLE',
          'Some items in your cart are no longer available. Remove them to continue.',
          { items: problems },
        );
      }

      // Authoritative pricing — the browser never supplies prices.
      const lines = cart.items.map(({ menuItem, quantity }) => ({
        menuItemId: menuItem.id,
        name: menuItem.name,
        unitPricePaise: menuItem.pricePaise,
        quantity,
        lineTotalPaise: menuItem.pricePaise * quantity,
        // Snapshot: the no-show policy uses the classification at the time of ordering.
        fulfillmentType: menuItem.fulfillmentType,
      }));
      const subtotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
      // There are no taxes or fees, so the whole subtotal is eligible for points, except
      // that at least ₹1 is always paid with money.
      if (pointsToRedeem > maxRedeemablePoints(subtotalPaise, Number.MAX_SAFE_INTEGER)) {
        throw new AppError(
          400,
          'POINTS_EXCEED_ORDER',
          'You can’t use that many points on this order.',
          { maxPoints: maxRedeemablePoints(subtotalPaise, Number.MAX_SAFE_INTEGER) },
        );
      }
      const pointsDiscountPaise = pointsToPaise(pointsToRedeem);
      // The scheduled-order fee is decided here, once per order — never by the browser.
      const scheduledFeePaise = feeFor(timing);
      const totalPaise = subtotalPaise - pointsDiscountPaise + scheduledFeePaise;
      if (totalPaise !== expectedTotalPaise) {
        throw new AppError(
          409,
          'PRICE_CHANGED',
          'Prices changed since you last looked. Please review your order.',
          {
            totalPaise,
          },
        );
      }

      // Pickup numbers count per collection day, so a scheduled order uses its slot's day.
      const day = istDay(scheduledFor ?? undefined);
      const pickupNumber = await nextPickupNumber(tx, outlet.id, day);
      const order = await tx.order.create({
        data: {
          userId,
          outletId: outlet.id,
          pickupDay: new Date(`${day}T00:00:00Z`),
          pickupNumber,
          pickupCode: formatPickupCode(outlet.name, pickupNumber),
          status: 'PLACED',
          paymentMethod,
          // A counter order is NOT paid just because it was created.
          paymentStatus: paymentMethod === 'WALLET' ? 'PAID' : 'PENDING_COUNTER',
          subtotalPaise,
          pointsRedeemed: pointsToRedeem,
          pointsDiscountPaise,
          timing,
          scheduledFor,
          scheduledFeePaise,
          totalPaise,
          idempotencyKey,
          items: { create: lines },
          history: { create: { toStatus: 'PLACED', actorUserId: userId, actorRole: 'STUDENT' } },
        },
      });

      // The outlet takes this order on now: claim one unit of its rolling capacity. Full →
      // 429 and the whole transaction (order, stock, points, payment, cart) rolls back.
      await claimOrderCapacity(tx, {
        outletId: outlet.id,
        orderId: order.id,
        limit: input.capacityLimit ?? ORDER_CAPACITY_PER_WINDOW,
      });

      await notify(
        tx,
        placedNotice({
          id: order.id,
          userId,
          pickupCode: order.pickupCode,
          outletName: outlet.name,
          scheduledFor,
        }),
      );

      // Counted items: take the stock now, atomically. Not enough left → nothing is saved.
      await deductForOrder(tx, {
        orderId: order.id,
        lines,
        items: cart.items.map(({ menuItem }) => menuItem),
        actor: { userId, role: 'STUDENT' },
      });

      if (pointsToRedeem > 0) {
        const wallet = await ensureWallet(tx, userId);
        // Atomic and conditional: throws INSUFFICIENT_POINTS, rolling back the order.
        await redeemForOrder(tx, {
          walletId: wallet.id,
          orderId: order.id,
          points: pointsToRedeem,
          label: `order ${order.pickupCode} at ${outlet.name}`,
          // Points come only from simulated recharges in this release.
          isSimulated: true,
        });
      }

      if (paymentMethod === 'WALLET') {
        const wallet = await ensureWallet(tx, userId);
        const balanceAfter = await debitBalance(tx, wallet.id, totalPaise);
        if (balanceAfter === null) {
          const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
          // Throwing rolls back the whole transaction, including the order above.
          throw new AppError(
            409,
            'INSUFFICIENT_BALANCE',
            'Your wallet balance is too low for this order.',
            {
              balancePaise: current.balancePaise,
              totalPaise,
              shortfallPaise: totalPaise - current.balancePaise,
            },
          );
        }
        const now = new Date();
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'ORDER_DEBIT',
            direction: 'DEBIT',
            amountPaise: totalPaise,
            balanceAfterPaise: balanceAfter,
            status: 'COMPLETED',
            completedAt: now,
            orderId: order.id,
            idempotencyKey: `order-debit:${order.id}`,
            description: `Order ${order.pickupCode} at ${outlet.name}`,
            // Wallet funds come only from simulated recharges in this release.
            isSimulated: true,
          },
        });
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { outletId: null } });
      return { orderId: order.id, created: true };
    });

    const order = await db.order.findUniqueOrThrow({
      where: { id: outcome.orderId },
      include: orderInclude,
    });
    return { order: toOrder(order), created: outcome.created };
  } catch (error) {
    // Same key submitted twice at once: the other request won — return its order.
    if (isUniqueViolation(error)) {
      const winner = await findByKey(db, userId, idempotencyKey);
      if (winner) return { order: winner, created: false };
    }
    throw error;
  }
}
