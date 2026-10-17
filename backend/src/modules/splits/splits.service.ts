import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { formatRupees, splitAmount } from '../../lib/allocation.js';
import type { PeerSplitMethod } from '../../generated/prisma/enums.js';
import { creditBalance, ensureWallet, refundToBalance } from '../wallet/wallet.service.js';

/*
 * Peer splits: one person (the owner) paid for something shared; the others repay their share
 * with a wallet-to-wallet transfer. Each repayment is ONE transaction: a debit from the payer, a
 * credit to the owner (respecting the owner's wallet cap) and a settlement record. Funds are
 * simulated in this release, like every CampusCart wallet balance.
 *
 * Rules: amounts and participants are fixed once created (only the title, description and due
 * date can change). Cancelling reverses every repayment — nothing is deleted.
 */

export const MAX_PARTICIPANTS = 20;

type Tx = DbClient;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export interface CreateSplitInput {
  ownerUserId: string;
  title: string;
  description?: string;
  totalPaise: number;
  expenseDate: string;
  dueDate?: string | null;
  method: PeerSplitMethod;
  participants: { email: string; percentBps?: number; customAmountPaise?: number }[];
}

export async function createSplit(db: Database, input: CreateSplitInput, maxBalancePaise: number) {
  const emails = input.participants.map((p) => p.email.trim().toLowerCase());
  if (new Set(emails).size !== emails.length) {
    throw new AppError(400, 'DUPLICATE_PARTICIPANTS', 'Each person can only be added once.');
  }
  const users = await db.user.findMany({
    where: { email: { in: emails, mode: 'insensitive' }, status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const unknown = emails.filter((e) => !byEmail.has(e));
  if (unknown.length > 0) {
    throw new AppError(
      400,
      'UNKNOWN_PARTICIPANTS',
      'Some people don’t have a CampusCart account.',
      { emails: unknown },
    );
  }
  const people = input.participants.map((p, i) => ({
    userId: byEmail.get(emails[i]!)!,
    percentBps: p.percentBps ?? null,
    customAmountPaise: p.customAmountPaise ?? null,
  }));
  if (!people.some((p) => p.userId !== input.ownerUserId)) {
    throw new AppError(400, 'NO_ONE_TO_SPLIT_WITH', 'Add at least one other person.');
  }
  // Owner first (if they share the cost), then in the order given: the rounding order.
  people.sort(
    (a, b) => (a.userId === input.ownerUserId ? -1 : 0) - (b.userId === input.ownerUserId ? -1 : 0),
  );
  const split = splitAmount(
    input.method,
    input.totalPaise,
    people.map((p) => ({
      id: p.userId,
      percentBps: p.percentBps,
      customPaise: p.customAmountPaise,
    })),
  );
  if (!split.ok) throw new AppError(400, split.code, split.message, split.details);
  const owed = split.amounts
    .filter((a) => a.id !== input.ownerUserId)
    .reduce((s, a) => s + a.amountPaise, 0);
  if (owed === 0)
    throw new AppError(400, 'NOTHING_OWED', 'Nobody else owes anything with this split.');
  if (owed > maxBalancePaise) {
    throw new AppError(
      400,
      'SPLIT_TOO_LARGE',
      `You can be repaid at most ${formatRupees(maxBalancePaise)} (your wallet limit).`,
    );
  }

  const created = await db.peerSplit.create({
    data: {
      ownerUserId: input.ownerUserId,
      title: input.title,
      description: input.description ?? '',
      totalPaise: input.totalPaise,
      expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
      dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
      method: input.method,
      participants: {
        create: split.amounts.map((a, position) => {
          const p = people.find((x) => x.userId === a.id)!;
          const isOwner = a.id === input.ownerUserId;
          return {
            userId: a.id,
            position,
            percentBps: p.percentBps,
            customAmountPaise: p.customAmountPaise,
            amountDuePaise: a.amountPaise,
            // The owner already paid the whole bill: their own share is covered.
            amountPaidPaise: isOwner ? a.amountPaise : 0,
            status: isOwner
              ? ('OWNER' as const)
              : a.amountPaise === 0
                ? ('PAID' as const)
                : ('UNPAID' as const),
          };
        }),
      },
    },
  });
  return created.id;
}

async function loadVisible(db: DbClient, splitId: string, userId: string) {
  const split = await db.peerSplit.findUnique({
    where: { id: splitId },
    include: {
      owner: { select: { id: true, displayName: true } },
      participants: {
        include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: { position: 'asc' },
      },
    },
  });
  if (!split) throw notFound('Split not found');
  const mine = split.participants.find((p) => p.userId === userId);
  if (split.ownerUserId !== userId && !mine) throw notFound('Split not found');
  return { split, mine };
}

const outstandingOf = (p: { status: string; amountDuePaise: number; amountPaidPaise: number }) =>
  p.status === 'UNPAID' || p.status === 'PARTIALLY_PAID' ? p.amountDuePaise - p.amountPaidPaise : 0;

function summarise(split: Awaited<ReturnType<typeof loadVisible>>['split'], userId: string) {
  const mine = split.participants.find((p) => p.userId === userId) ?? null;
  const isOwner = split.ownerUserId === userId;
  const others = split.participants.filter((p) => p.status !== 'OWNER');
  return {
    id: split.id,
    title: split.title,
    description: split.description,
    totalPaise: split.totalPaise,
    currency: split.currency,
    method: split.method,
    status: split.status,
    expenseDate: dayOf(split.expenseDate),
    dueDate: split.dueDate ? dayOf(split.dueDate) : null,
    owner: split.owner,
    isOwner,
    participants: split.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      avatarUrl: p.user.avatarUrl,
      amountDuePaise: p.amountDuePaise,
      amountPaidPaise: p.status === 'OWNER' ? 0 : p.amountPaidPaise,
      outstandingPaise: outstandingOf(p),
      status: p.status,
    })),
    /** What the viewer owes (null for the owner). */
    myShare:
      mine && mine.status !== 'OWNER'
        ? {
            amountDuePaise: mine.amountDuePaise,
            amountPaidPaise: mine.amountPaidPaise,
            outstandingPaise: outstandingOf(mine),
            status: mine.status,
          }
        : null,
    /** Still to be repaid to the owner, by everyone. */
    totalOutstandingPaise: others.reduce((a, p) => a + outstandingOf(p), 0),
    cancelledAt: split.cancelledAt?.toISOString() ?? null,
    cancelReason: split.cancelReason,
    createdAt: split.createdAt.toISOString(),
    updatedAt: split.updatedAt.toISOString(),
  };
}

export async function listSplits(db: Database, userId: string) {
  const ids = await db.peerSplit.findMany({
    where: { OR: [{ ownerUserId: userId }, { participants: { some: { userId } } }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true },
  });
  const splits = await Promise.all(ids.map(({ id }) => loadVisible(db, id, userId)));
  return splits.map(({ split }) => summarise(split, userId));
}

/** One split. The owner sees every repayment; a participant sees only their own. */
export async function getSplit(db: Database, splitId: string, userId: string) {
  const { split } = await loadVisible(db, splitId, userId);
  const settlements = await db.peerSplitSettlement.findMany({
    where: { splitId, ...(split.ownerUserId === userId ? {} : { payerUserId: userId }) },
    orderBy: { createdAt: 'asc' },
    include: { payer: { select: { displayName: true } } },
  });
  return {
    ...summarise(split, userId),
    settlements: settlements.map((s) => ({
      id: s.id,
      payer: s.payer.displayName,
      amountPaise: s.amountPaise,
      status: s.status,
      transactionId: s.payerUserId === userId ? s.debitTransactionId : s.creditTransactionId,
      createdAt: s.createdAt.toISOString(),
      reversedAt: s.reversedAt?.toISOString() ?? null,
    })),
  };
}

export async function updateSplit(
  db: Database,
  params: {
    splitId: string;
    userId: string;
    title?: string;
    description?: string;
    dueDate?: string | null;
  },
) {
  const split = await db.peerSplit.findUnique({ where: { id: params.splitId } });
  if (!split || split.ownerUserId !== params.userId) throw notFound('Split not found');
  if (split.status !== 'OPEN')
    throw new AppError(409, 'SPLIT_CLOSED', `This split is ${split.status.toLowerCase()}.`);
  const { count } = await db.peerSplit.updateMany({
    where: { id: split.id, version: split.version, status: 'OPEN' },
    data: {
      ...(params.title !== undefined && { title: params.title }),
      ...(params.description !== undefined && { description: params.description }),
      ...(params.dueDate !== undefined && {
        dueDate: params.dueDate ? new Date(`${params.dueDate}T00:00:00Z`) : null,
      }),
      version: { increment: 1 },
    },
  });
  if (count === 0)
    throw new AppError(409, 'SPLIT_CHANGED', 'This split just changed. Reload and try again.');
}

/** Locks the given wallets in a fixed order, so two transfers in opposite directions can't deadlock. */
async function lockWallets(tx: Tx, walletIds: string[]) {
  const sorted = [...new Set(walletIds)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${id}::uuid FOR UPDATE`;
  }
}

/**
 * Repays some or all of the caller's outstanding share, wallet to wallet. Never more than is
 * owed; the client's Idempotency-Key makes retries return the original settlement.
 */
export async function settleShare(
  db: Database,
  params: {
    splitId: string;
    userId: string;
    amountPaise: number;
    idempotencyKey: string;
    maxBalancePaise: number;
  },
) {
  const key = `peer:${params.userId}:${params.idempotencyKey}`;
  const previous = await db.peerSplitSettlement.findUnique({ where: { idempotencyKey: key } });
  if (previous) {
    if (previous.splitId !== params.splitId || previous.amountPaise !== params.amountPaise) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'That request key was already used for a different payment.',
      );
    }
    return { created: false, recipientUserId: previous.recipientUserId };
  }
  try {
    const outcome = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PeerSplitParticipant"
        WHERE "splitId" = ${params.splitId}::uuid AND "userId" = ${params.userId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw notFound('Split not found');
      // A copy of this request that was waiting on the lock: return what the first one did.
      const dup = await tx.peerSplitSettlement.findUnique({ where: { idempotencyKey: key } });
      if (dup) return { duplicate: true as const, recipientUserId: dup.recipientUserId };
      const participant = await tx.peerSplitParticipant.findUniqueOrThrow({
        where: { id: rows[0]!.id },
      });
      const split = await tx.peerSplit.findUniqueOrThrow({ where: { id: params.splitId } });
      if (split.status !== 'OPEN')
        throw new AppError(409, 'SPLIT_CLOSED', `This split is ${split.status.toLowerCase()}.`);
      if (participant.status === 'OWNER')
        throw new AppError(409, 'NOTHING_OWED', 'You paid this bill, so you don’t owe anything.');
      const outstanding = outstandingOf(participant);
      if (outstanding === 0)
        throw new AppError(409, 'ALREADY_SETTLED', 'Your share is already settled.');
      if (params.amountPaise > outstanding) {
        throw new AppError(
          409,
          'OVERPAYMENT',
          `You owe ${formatRupees(outstanding)}; you can’t pay more than that.`,
          {
            outstandingPaise: outstanding,
          },
        );
      }
      if (params.amountPaise < Math.min(100, outstanding)) {
        throw new AppError(
          400,
          'AMOUNT_TOO_SMALL',
          'Pay at least ₹1 (or whatever is left, if less).',
        );
      }

      const payerWallet = await ensureWallet(tx, params.userId);
      const ownerWallet = await ensureWallet(tx, split.ownerUserId);
      await lockWallets(tx, [payerWallet.id, ownerWallet.id]);
      const debited = await tx.$queryRaw<{ balancePaise: number }[]>`
        UPDATE "Wallet" SET "balancePaise" = "balancePaise" - ${params.amountPaise}, "updatedAt" = (now() AT TIME ZONE 'UTC')
        WHERE id = ${payerWallet.id}::uuid AND "balancePaise" >= ${params.amountPaise}
        RETURNING "balancePaise"`;
      if (debited.length === 0) {
        const current = await tx.wallet.findUniqueOrThrow({ where: { id: payerWallet.id } });
        throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Your wallet balance is too low.', {
          balancePaise: current.balancePaise,
          amountPaise: params.amountPaise,
          shortfallPaise: params.amountPaise - current.balancePaise,
        });
      }
      const credited = await creditBalance(
        tx,
        ownerWallet.id,
        params.amountPaise,
        params.maxBalancePaise,
      );
      if (credited === null) {
        throw new AppError(
          409,
          'RECIPIENT_WALLET_FULL',
          'The person you’re repaying has reached their wallet limit, so this can’t go through right now.',
        );
      }
      const now = new Date();
      const debit = await tx.walletTransaction.create({
        data: {
          walletId: payerWallet.id,
          type: 'PEER_TRANSFER_OUT',
          direction: 'DEBIT',
          amountPaise: params.amountPaise,
          balanceAfterPaise: debited[0]!.balancePaise,
          status: 'COMPLETED',
          completedAt: now,
          idempotencyKey: `${key}:out`,
          description: `Repaid “${split.title}”`,
          isSimulated: true,
        },
      });
      const credit = await tx.walletTransaction.create({
        data: {
          walletId: ownerWallet.id,
          type: 'PEER_TRANSFER_IN',
          direction: 'CREDIT',
          amountPaise: params.amountPaise,
          balanceAfterPaise: credited,
          status: 'COMPLETED',
          completedAt: now,
          idempotencyKey: `${key}:in`,
          description: `Repayment for “${split.title}”`,
          isSimulated: true,
        },
      });
      await tx.peerSplitSettlement.create({
        data: {
          splitId: split.id,
          participantId: participant.id,
          payerUserId: params.userId,
          recipientUserId: split.ownerUserId,
          amountPaise: params.amountPaise,
          idempotencyKey: key,
          debitTransactionId: debit.id,
          creditTransactionId: credit.id,
        },
      });
      const paid = participant.amountPaidPaise + params.amountPaise;
      await tx.peerSplitParticipant.update({
        where: { id: participant.id },
        data: {
          amountPaidPaise: paid,
          status: paid === participant.amountDuePaise ? 'PAID' : 'PARTIALLY_PAID',
        },
      });
      const open = await tx.peerSplitParticipant.count({
        where: { splitId: split.id, status: { in: ['UNPAID', 'PARTIALLY_PAID'] } },
      });
      if (open === 0)
        await tx.peerSplit.update({
          where: { id: split.id },
          data: { status: 'SETTLED', version: { increment: 1 } },
        });
      return { duplicate: false as const, recipientUserId: split.ownerUserId };
    });
    return { created: !outcome.duplicate, recipientUserId: outcome.recipientUserId };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await db.peerSplitSettlement.findUnique({ where: { idempotencyKey: key } });
      if (winner) return { created: false, recipientUserId: winner.recipientUserId };
    }
    throw error;
  }
}

/**
 * The owner cancels: every repayment is sent back (a REVERSAL debit from the owner and a REVERSAL
 * credit to the payer, both linked to the originals). Refused, with nothing changed, if the
 * owner's balance can't cover the reversals.
 */
export async function cancelSplit(
  db: Database,
  params: { splitId: string; userId: string; reason?: string },
) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "PeerSplit" WHERE id = ${params.splitId}::uuid AND "ownerUserId" = ${params.userId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound('Split not found');
    const split = await tx.peerSplit.findUniqueOrThrow({ where: { id: params.splitId } });
    if (split.status === 'CANCELLED')
      throw new AppError(409, 'SPLIT_CLOSED', 'This split is already cancelled.');
    const settlements = await tx.peerSplitSettlement.findMany({
      where: { splitId: split.id, status: 'COMPLETED' },
      include: { debitTransaction: true, creditTransaction: true },
    });
    const owed = settlements.reduce((a, s) => a + s.amountPaise, 0);
    const now = new Date();
    if (settlements.length > 0) {
      const ownerWalletId = settlements[0]!.creditTransaction.walletId;
      await lockWallets(tx, [
        ownerWalletId,
        ...settlements.map((s) => s.debitTransaction.walletId),
      ]);
      const owner = await tx.wallet.findUniqueOrThrow({ where: { id: ownerWalletId } });
      if (owner.balancePaise < owed) {
        throw new AppError(
          409,
          'OWNER_BALANCE_TOO_LOW',
          `Cancelling sends back ${formatRupees(owed)} you were repaid, but your wallet has ${formatRupees(owner.balancePaise)}.`,
          {
            requiredPaise: owed,
            balancePaise: owner.balancePaise,
          },
        );
      }
      for (const s of settlements) {
        const ownerAfter = await tx.$queryRaw<{ balancePaise: number }[]>`
          UPDATE "Wallet" SET "balancePaise" = "balancePaise" - ${s.amountPaise}, "updatedAt" = (now() AT TIME ZONE 'UTC')
          WHERE id = ${ownerWalletId}::uuid AND "balancePaise" >= ${s.amountPaise} RETURNING "balancePaise"`;
        const back = await tx.walletTransaction.create({
          data: {
            walletId: ownerWalletId,
            type: 'REVERSAL',
            direction: 'DEBIT',
            amountPaise: s.amountPaise,
            balanceAfterPaise: ownerAfter[0]!.balancePaise,
            status: 'COMPLETED',
            completedAt: now,
            reversesTransactionId: s.creditTransactionId,
            idempotencyKey: `peer-reversal:${s.id}:out`,
            description: `Returned repayment — “${split.title}” was cancelled`,
            isSimulated: true,
          },
        });
        const payerAfter = await refundToBalance(tx, s.debitTransaction.walletId, s.amountPaise);
        const refund = await tx.walletTransaction.create({
          data: {
            walletId: s.debitTransaction.walletId,
            type: 'REVERSAL',
            direction: 'CREDIT',
            amountPaise: s.amountPaise,
            balanceAfterPaise: payerAfter,
            status: 'COMPLETED',
            completedAt: now,
            reversesTransactionId: s.debitTransactionId,
            idempotencyKey: `peer-reversal:${s.id}:in`,
            description: `Repayment returned — “${split.title}” was cancelled`,
            isSimulated: true,
          },
        });
        await tx.peerSplitSettlement.update({
          where: { id: s.id },
          data: {
            status: 'REVERSED',
            reversedAt: now,
            reversalDebitTransactionId: back.id,
            reversalCreditTransactionId: refund.id,
          },
        });
      }
    }
    await tx.peerSplitParticipant.updateMany({
      where: { splitId: split.id, status: { not: 'OWNER' } },
      data: { status: 'CANCELLED' },
    });
    await tx.peerSplit.update({
      where: { id: split.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelReason: params.reason ?? null,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: params.userId },
      action: 'PEER_SPLIT_CANCELLED',
      entityType: 'PeerSplit',
      entityId: split.id,
      metadata: {
        reversedPaise: owed,
        reversals: settlements.length,
        reason: params.reason ?? null,
      },
    });
    const participants = await tx.peerSplitParticipant.findMany({
      where: { splitId: split.id },
      select: { userId: true },
    });
    return {
      userIds: participants.map((p) => p.userId),
      reversedPayers: settlements.map((s) => s.payerUserId),
    };
  });
}

export async function participantIds(db: DbClient, splitId: string) {
  const split = await db.peerSplit.findUnique({
    where: { id: splitId },
    include: { participants: { select: { userId: true } } },
  });
  return split ? [split.ownerUserId, ...split.participants.map((p) => p.userId)] : [];
}
