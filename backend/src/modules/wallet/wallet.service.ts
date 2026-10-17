import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env.js';
import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { RechargeProvider } from '../payments/providers.js';
import type { PaymentAttempt, Wallet, WalletTransaction } from '../../generated/prisma/client.js';
import { awardRechargePoints } from '../loyalty/loyalty.service.js';
import {
  POINT_VALUE_PAISE,
  RECHARGE_BONUS_SLABS,
  bonusPointsFor,
  rechargeMinPaise,
} from '../loyalty/loyalty.rules.js';

export const RECHARGE_TTL_MS = 15 * 60 * 1000;
export type WalletLimits = Pick<
  Env,
  'WALLET_RECHARGE_MIN_PAISE' | 'WALLET_RECHARGE_MAX_PAISE' | 'WALLET_MAX_BALANCE_PAISE'
>;
export type MockOutcome = 'SUCCESS' | 'FAILURE' | 'CANCEL';

// ─── Wallet and balance primitives ───────────────────────────────────────────

/**
 * Every user gets a wallet on first use, at the approved starting balance of ₹0 (decision Q1).
 * A single INSERT … ON CONFLICT DO NOTHING, so several first requests arriving together
 * (the wallet page loads three at once) can't collide on the unique userId. It never
 * raises an error, so it is also safe inside a transaction.
 */
export async function ensureWallet(db: DbClient, userId: string): Promise<Wallet> {
  await db.$executeRaw`
    INSERT INTO "Wallet" ("id", "userId", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    ON CONFLICT ("userId") DO NOTHING`;
  return db.wallet.findUniqueOrThrow({ where: { userId } });
}

/**
 * Adds money atomically, refusing to exceed the wallet cap. Returns the new
 * balance, or null if the cap would be exceeded. Must run inside a transaction
 * that also writes the matching ledger row.
 */
export async function creditBalance(
  tx: DbClient,
  walletId: string,
  amountPaise: number,
  maxBalancePaise: number,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ balancePaise: number }[]>`
    UPDATE "Wallet"
    SET "balancePaise" = "balancePaise" + ${amountPaise}, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${walletId}::uuid AND "balancePaise" + ${amountPaise} <= ${maxBalancePaise}
    RETURNING "balancePaise"`;
  return rows[0]?.balancePaise ?? null;
}

/**
 * Takes money atomically, only if enough is there. Returns the new balance, or
 * null if the balance is insufficient.
 *
 * Why this cannot overspend: PostgreSQL locks the wallet row for the UPDATE. A
 * second concurrent debit waits, then re-checks "balancePaise >= amount"
 * against the already-reduced balance. The CHECK (balancePaise >= 0) on the
 * table is a second safety net.
 */
export async function debitBalance(
  tx: DbClient,
  walletId: string,
  amountPaise: number,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ balancePaise: number }[]>`
    UPDATE "Wallet"
    SET "balancePaise" = "balancePaise" - ${amountPaise}, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${walletId}::uuid AND "balancePaise" >= ${amountPaise}
    RETURNING "balancePaise"`;
  return rows[0]?.balancePaise ?? null;
}

/**
 * Returns money to a wallet for a refund. Unlike recharges, refunds are NOT
 * limited by the balance cap: money the student already paid must always be
 * returnable. Must run inside the transaction that writes the REFUND row.
 */
export async function refundToBalance(
  tx: DbClient,
  walletId: string,
  amountPaise: number,
): Promise<number> {
  const rows = await tx.$queryRaw<{ balancePaise: number }[]>`
    UPDATE "Wallet"
    SET "balancePaise" = "balancePaise" + ${amountPaise}, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id = ${walletId}::uuid
    RETURNING "balancePaise"`;
  const balance = rows[0]?.balancePaise;
  if (balance === undefined) throw new Error(`Wallet ${walletId} not found for refund`);
  return balance;
}

// ─── Read models ─────────────────────────────────────────────────────────────

export function toTransaction(t: WalletTransaction) {
  return {
    id: t.id,
    type: t.type,
    direction: t.direction,
    amountPaise: t.amountPaise,
    balanceAfterPaise: t.balanceAfterPaise,
    status: t.status,
    description: t.description,
    orderId: t.orderId,
    rechargeId: t.paymentAttemptId,
    isSimulated: t.isSimulated,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

export function toRecharge(a: PaymentAttempt) {
  return {
    id: a.id,
    amountPaise: a.amountPaise,
    currency: a.currency,
    status: a.status,
    /** Bonus points promised for this recharge; awarded only when it SUCCEEDED. */
    bonusPoints: a.bonusPoints,
    provider: a.provider,
    providerReference: a.providerReference,
    isSimulated: a.isSimulated,
    failureReason: a.failureReason,
    expiresAt: a.expiresAt,
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}

export async function getWalletSummary(
  db: DbClient,
  userId: string,
  limits: WalletLimits,
  provider: RechargeProvider | null,
) {
  const wallet = await ensureWallet(db, userId);
  return {
    id: wallet.id,
    balancePaise: wallet.balancePaise,
    currency: wallet.currency,
    loyalty: {
      pointsBalance: wallet.pointsBalance,
      pointValuePaise: POINT_VALUE_PAISE,
      rechargeBonusSlabs: RECHARGE_BONUS_SLABS,
    },
    recharge: {
      available: provider !== null,
      mode: provider?.name ?? null,
      isSimulated: provider?.isSimulated ?? false,
      minPaise: rechargeMinPaise(limits.WALLET_RECHARGE_MIN_PAISE),
      maxPaise: limits.WALLET_RECHARGE_MAX_PAISE,
      maxBalancePaise: limits.WALLET_MAX_BALANCE_PAISE,
    },
  };
}

function encodeCursor(t: { createdAt: Date; id: string }) {
  return Buffer.from(`${t.createdAt.toISOString()}|${t.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
  }
  return { createdAt, id };
}

/** Newest first, keyset-paginated, for the signed-in user's own wallet only. */
export async function listTransactions(
  db: Database,
  userId: string,
  options: { limit: number; cursor?: string },
) {
  await expireStaleRecharges(db, userId);
  const wallet = await ensureWallet(db, userId);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await db.walletTransaction.findMany({
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
    transactions: page.map(toTransaction),
    nextCursor: rows.length > options.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function getTransaction(db: Database, userId: string, transactionId: string) {
  const t = await db.walletTransaction.findFirst({
    where: { id: transactionId, wallet: { userId } },
  });
  if (!t) throw notFound('Transaction not found');
  return toTransaction(t);
}

// ─── Recharge lifecycle ──────────────────────────────────────────────────────

/** Marks this user's PENDING recharges past their expiry as EXPIRED (lazily, on read). */
export async function expireStaleRecharges(db: Database, userId: string) {
  const now = new Date();
  const stale = await db.paymentAttempt.findMany({
    where: { userId, status: 'PENDING', expiresAt: { lte: now } },
    select: { id: true },
  });
  for (const { id } of stale) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.paymentAttempt.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'EXPIRED', failureReason: 'Not completed in time', completedAt: now },
      });
      if (count === 1) {
        await tx.walletTransaction.updateMany({
          where: { paymentAttemptId: id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
      }
    });
  }
}

/**
 * Starts a recharge: validates it, then records a PENDING payment attempt and a
 * PENDING ledger row. Nothing is credited yet. Repeating the request with the
 * same idempotency key returns the same attempt.
 */
export async function createRecharge(
  db: Database,
  params: {
    userId: string;
    amountPaise: number;
    idempotencyKey: string;
    limits: WalletLimits;
    provider: RechargeProvider | null;
  },
) {
  const { userId, amountPaise, idempotencyKey, limits, provider } = params;
  if (!provider) {
    throw new AppError(503, 'RECHARGE_UNAVAILABLE', 'Wallet recharge is not available right now.');
  }

  const existing = await db.paymentAttempt.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
  if (existing) {
    if (existing.amountPaise !== amountPaise) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This request key was already used for a different amount.',
      );
    }
    return { recharge: toRecharge(existing), created: false };
  }

  if (amountPaise % 100 !== 0) {
    throw new AppError(
      400,
      'AMOUNT_NOT_WHOLE_RUPEES',
      'Recharge amounts must be a whole number of rupees.',
    );
  }
  const minPaise = rechargeMinPaise(limits.WALLET_RECHARGE_MIN_PAISE);
  if (amountPaise < minPaise || amountPaise > limits.WALLET_RECHARGE_MAX_PAISE) {
    throw new AppError(
      400,
      'AMOUNT_OUT_OF_RANGE',
      amountPaise < minPaise
        ? `The minimum recharge is ₹${minPaise / 100}.`
        : 'Recharge amount is outside the allowed range.',
      { minPaise, maxPaise: limits.WALLET_RECHARGE_MAX_PAISE },
    );
  }

  const wallet = await ensureWallet(db, userId);
  if (wallet.balancePaise + amountPaise > limits.WALLET_MAX_BALANCE_PAISE) {
    throw new AppError(
      409,
      'WALLET_LIMIT',
      'This recharge would take your wallet over its maximum balance.',
      {
        balancePaise: wallet.balancePaise,
        maxBalancePaise: limits.WALLET_MAX_BALANCE_PAISE,
      },
    );
  }

  const { providerReference } = await provider.prepareRecharge({ amountPaise });
  try {
    const attempt = await db.$transaction(async (tx) => {
      const created = await tx.paymentAttempt.create({
        data: {
          userId,
          walletId: wallet.id,
          purpose: 'WALLET_RECHARGE',
          provider: provider.name,
          providerReference,
          amountPaise,
          status: 'PENDING',
          // Fixed now, so the student gets exactly the bonus they were shown.
          bonusPoints: bonusPointsFor(amountPaise),
          isSimulated: provider.isSimulated,
          idempotencyKey,
          expiresAt: new Date(Date.now() + RECHARGE_TTL_MS),
        },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'RECHARGE',
          direction: 'CREDIT',
          amountPaise,
          status: 'PENDING',
          paymentAttemptId: created.id,
          idempotencyKey: `recharge:${created.id}`,
          description: provider.isSimulated
            ? 'Wallet recharge (simulated — test mode)'
            : 'Wallet recharge',
          isSimulated: provider.isSimulated,
        },
      });
      return created;
    });
    return { recharge: toRecharge(attempt), created: true };
  } catch (error) {
    // The same key submitted twice at the same moment: return the winner's attempt.
    if (isUniqueViolation(error)) {
      const winner = await db.paymentAttempt.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (winner) return { recharge: toRecharge(winner), created: false };
    }
    throw error;
  }
}

export async function getRecharge(db: Database, userId: string, attemptId: string) {
  await expireStaleRecharges(db, userId);
  const attempt = await db.paymentAttempt.findFirst({ where: { id: attemptId, userId } });
  if (!attempt) throw notFound('Recharge not found');
  return toRecharge(attempt);
}

/**
 * Applies a provider outcome to a PENDING recharge. Safe to call any number of
 * times, including concurrently: only the call that moves the attempt out of
 * PENDING has any effect, so a recharge is credited at most once.
 *
 * Today the outcome comes from the mock simulator. A real provider's verified
 * webhook would call this same function.
 */
export async function settleRecharge(
  db: Database,
  params: { userId: string; attemptId: string; outcome: MockOutcome; limits: WalletLimits },
) {
  const { userId, attemptId, outcome, limits } = params;
  await expireStaleRecharges(db, userId);

  const result = await db.$transaction(async (tx) => {
    const attempt = await tx.paymentAttempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) throw notFound('Recharge not found');

    const now = new Date();
    const target =
      outcome === 'SUCCESS' ? 'SUCCEEDED' : outcome === 'FAILURE' ? 'FAILED' : 'CANCELLED';

    // Claim the attempt. Only one caller can move it out of PENDING.
    const claimed = await tx.paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'PENDING', expiresAt: { gt: now } },
      data: {
        status: target,
        completedAt: now,
        failureReason:
          target === 'FAILED'
            ? 'Simulated payment failure'
            : target === 'CANCELLED'
              ? 'Cancelled'
              : null,
      },
    });
    if (claimed.count === 0) return { changed: false };

    if (target !== 'SUCCEEDED') {
      await tx.walletTransaction.update({
        where: { paymentAttemptId: attempt.id },
        data: { status: target === 'FAILED' ? 'FAILED' : 'CANCELLED' },
      });
      return { changed: true };
    }

    const balanceAfter = await creditBalance(
      tx,
      attempt.walletId,
      attempt.amountPaise,
      limits.WALLET_MAX_BALANCE_PAISE,
    );
    if (balanceAfter === null) {
      // Balance grew since the recharge started (e.g. a refund) and this would breach the cap.
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureReason: 'Would exceed the maximum wallet balance' },
      });
      await tx.walletTransaction.update({
        where: { paymentAttemptId: attempt.id },
        data: { status: 'FAILED' },
      });
      return { changed: true };
    }

    await tx.walletTransaction.update({
      where: { paymentAttemptId: attempt.id },
      data: { status: 'COMPLETED', balanceAfterPaise: balanceAfter, completedAt: now },
    });
    // Points only for a verified, credited recharge — in this same transaction, once.
    await awardRechargePoints(tx, attempt);
    return { changed: true };
  });

  const [attempt, wallet] = await Promise.all([
    db.paymentAttempt.findFirstOrThrow({ where: { id: attemptId, userId } }),
    db.wallet.findUniqueOrThrow({ where: { userId } }),
  ]);
  return {
    changed: result.changed,
    recharge: toRecharge(attempt),
    wallet: {
      id: wallet.id,
      balancePaise: wallet.balancePaise,
      pointsBalance: wallet.pointsBalance,
      currency: wallet.currency,
    },
  };
}
