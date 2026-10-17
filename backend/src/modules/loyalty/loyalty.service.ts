import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import type { LoyaltyTransaction } from '../../generated/prisma/client.js';
import { ensureWallet } from '../wallet/wallet.service.js';
import { pointsToPaise } from './loyalty.rules.js';

/*
 * Points balance primitives. Like the money primitives, each is a single conditional
 * UPDATE on the wallet row (which PostgreSQL locks), and each must run inside the
 * transaction that writes the matching LoyaltyTransaction row.
 */

/** Adds points. Returns the new points balance. */
export async function addPoints(tx: DbClient, walletId: string, points: number): Promise<number> {
  const rows = await tx.$queryRaw<{ pointsBalance: number }[]>`
    UPDATE "Wallet"
    SET "pointsBalance" = "pointsBalance" + ${points}, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${walletId}::uuid
    RETURNING "pointsBalance"`;
  const balance = rows[0]?.pointsBalance;
  if (balance === undefined) throw new Error(`Wallet ${walletId} not found for points`);
  return balance;
}

/**
 * Takes points only if enough are there. Returns the new balance, or null when the
 * balance is too low. A second concurrent spend waits for the row lock and re-checks
 * against the reduced balance, so the same points can never be spent twice.
 */
export async function takePoints(
  tx: DbClient,
  walletId: string,
  points: number,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ pointsBalance: number }[]>`
    UPDATE "Wallet"
    SET "pointsBalance" = "pointsBalance" - ${points}, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${walletId}::uuid AND "pointsBalance" >= ${points}
    RETURNING "pointsBalance"`;
  return rows[0]?.pointsBalance ?? null;
}

/** Awards a successful recharge's bonus. The unique paymentAttemptId makes a second award impossible. */
export async function awardRechargePoints(
  tx: DbClient,
  attempt: {
    id: string;
    walletId: string;
    bonusPoints: number;
    amountPaise: number;
    isSimulated: boolean;
  },
) {
  if (attempt.bonusPoints <= 0) return null;
  const balanceAfter = await addPoints(tx, attempt.walletId, attempt.bonusPoints);
  return tx.loyaltyTransaction.create({
    data: {
      walletId: attempt.walletId,
      type: 'EARNED_RECHARGE',
      direction: 'CREDIT',
      points: attempt.bonusPoints,
      pointsBalanceAfter: balanceAfter,
      paymentAttemptId: attempt.id,
      idempotencyKey: `loyalty-earn:${attempt.id}`,
      description: `Bonus for a ₹${attempt.amountPaise / 100} recharge${attempt.isSimulated ? ' (test mode)' : ''}`,
      isSimulated: attempt.isSimulated,
    },
  });
}

/** Spends points on a new order. Throws (rolling back the checkout) if the balance is too low. */
export async function redeemForOrder(
  tx: DbClient,
  params: {
    walletId: string;
    orderId: string;
    points: number;
    label: string;
    isSimulated: boolean;
  },
) {
  const balanceAfter = await takePoints(tx, params.walletId, params.points);
  if (balanceAfter === null) {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: params.walletId } });
    throw new AppError(409, 'INSUFFICIENT_POINTS', 'You don’t have that many loyalty points.', {
      pointsBalance: wallet.pointsBalance,
      requested: params.points,
    });
  }
  return tx.loyaltyTransaction.create({
    data: {
      walletId: params.walletId,
      type: 'REDEEMED_ORDER',
      direction: 'DEBIT',
      points: params.points,
      pointsBalanceAfter: balanceAfter,
      orderId: params.orderId,
      idempotencyKey: `loyalty-redeem:${params.orderId}`,
      description: `₹${pointsToPaise(params.points) / 100} off ${params.label}`,
      isSimulated: params.isSimulated,
    },
  });
}

/**
 * Gives back the points spent on an order that was rejected or cancelled. Returns the
 * points restored (0 if none were spent). unique(orderId, type) makes a second
 * restoration impossible even if this were ever called twice.
 */
export async function restoreForOrder(
  tx: DbClient,
  params: { orderId: string; label: string },
): Promise<number> {
  const redeemed = await tx.loyaltyTransaction.findUnique({
    where: { orderId_type: { orderId: params.orderId, type: 'REDEEMED_ORDER' } },
  });
  if (!redeemed) return 0;
  const balanceAfter = await addPoints(tx, redeemed.walletId, redeemed.points);
  await tx.loyaltyTransaction.create({
    data: {
      walletId: redeemed.walletId,
      type: 'RESTORED_ORDER',
      direction: 'CREDIT',
      points: redeemed.points,
      pointsBalanceAfter: balanceAfter,
      orderId: params.orderId,
      reversesId: redeemed.id,
      idempotencyKey: `loyalty-restore:${params.orderId}`,
      description: `Points returned: ${params.label}`,
      isSimulated: redeemed.isSimulated,
    },
  });
  return redeemed.points;
}

export function toLoyaltyTransaction(t: LoyaltyTransaction) {
  return {
    id: t.id,
    type: t.type,
    direction: t.direction,
    points: t.points,
    pointsBalanceAfter: t.pointsBalanceAfter,
    rechargeId: t.paymentAttemptId,
    orderId: t.orderId,
    description: t.description,
    isSimulated: t.isSimulated,
    createdAt: t.createdAt,
  };
}

const encode = (t: { createdAt: Date; id: string }) =>
  Buffer.from(`${t.createdAt.toISOString()}|${t.id}`).toString('base64url');

function decode(cursor: string) {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
  }
  return { createdAt, id };
}

/** The signed-in student's own points ledger, newest first. */
export async function listLoyaltyTransactions(
  db: Database,
  userId: string,
  options: { limit: number; cursor?: string },
) {
  const wallet = await ensureWallet(db, userId);
  const after = options.cursor ? decode(options.cursor) : null;
  const rows = await db.loyaltyTransaction.findMany({
    where: {
      walletId: wallet.id,
      ...(after && {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  return {
    pointsBalance: wallet.pointsBalance,
    transactions: page.map(toLoyaltyTransaction),
    nextCursor: rows.length > options.limit ? encode(page[page.length - 1]!) : null,
  };
}
