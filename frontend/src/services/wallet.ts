import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';

export const walletSchema = z.object({
  id: z.string(),
  balancePaise: z.number().int(),
  currency: z.literal('INR'),
  /** Loyalty points are kept apart from money: 1 point = ₹1 off an order, never cash. */
  loyalty: z.object({
    pointsBalance: z.number().int(),
    pointValuePaise: z.number().int(),
    /** The ONLY recharge amounts that earn a bonus, straight from the server's rules. */
    rechargeBonusSlabs: z.array(
      z.object({ amountPaise: z.number().int(), points: z.number().int() }),
    ),
  }),
  recharge: z.object({
    available: z.boolean(),
    mode: z.literal('MOCK').nullable(),
    isSimulated: z.boolean(),
    minPaise: z.number().int(),
    maxPaise: z.number().int(),
    maxBalancePaise: z.number().int(),
  }),
});
export type Wallet = z.infer<typeof walletSchema>;

export const transactionSchema = z.object({
  id: z.string(),
  type: z.enum([
    'RECHARGE',
    'ORDER_DEBIT',
    'REFUND',
    'REVERSAL',
    'GROUP_SHARE_PAYMENT',
    'PEER_TRANSFER_OUT',
    'PEER_TRANSFER_IN',
  ]),
  direction: z.enum(['CREDIT', 'DEBIT']),
  amountPaise: z.number().int(),
  balanceAfterPaise: z.number().int().nullable(),
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  description: z.string(),
  orderId: z.string().nullable(),
  rechargeId: z.string().nullable(),
  isSimulated: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type WalletTransaction = z.infer<typeof transactionSchema>;

export const rechargeSchema = z.object({
  id: z.string(),
  amountPaise: z.number().int(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  /** Promised bonus; awarded by the server only if the recharge succeeds. */
  bonusPoints: z.number().int(),
  provider: z.literal('MOCK'),
  providerReference: z.string(),
  isSimulated: z.boolean(),
  failureReason: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Recharge = z.infer<typeof rechargeSchema>;

export const walletKey = ['wallet'] as const;
const transactionsKey = ['wallet', 'transactions'] as const;
const pointsKey = ['wallet', 'points'] as const;

export const loyaltyTransactionSchema = z.object({
  id: z.string(),
  type: z.enum(['EARNED_RECHARGE', 'REDEEMED_ORDER', 'RESTORED_ORDER']),
  direction: z.enum(['CREDIT', 'DEBIT']),
  points: z.number().int(),
  pointsBalanceAfter: z.number().int(),
  rechargeId: z.string().nullable(),
  orderId: z.string().nullable(),
  description: z.string(),
  isSimulated: z.boolean(),
  createdAt: z.string(),
});
export type LoyaltyTransaction = z.infer<typeof loyaltyTransactionSchema>;

const pointsPageSchema = z.object({
  pointsBalance: z.number().int(),
  transactions: z.array(loyaltyTransactionSchema),
  nextCursor: z.string().nullable(),
});

/** The student's own loyalty-points history, newest first. */
export function useLoyaltyTransactions() {
  return useInfiniteQuery({
    queryKey: pointsKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      pointsPageSchema.parse(
        await apiFetch(
          `/wallet/points?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** The bonus the server's rules give for exactly this amount (0 for any other amount). */
export function bonusFor(wallet: Wallet, amountPaise: number): number {
  return wallet.loyalty.rechargeBonusSlabs.find((s) => s.amountPaise === amountPaise)?.points ?? 0;
}

export function useWallet(enabled = true) {
  return useQuery({
    queryKey: walletKey,
    queryFn: async () => z.object({ wallet: walletSchema }).parse(await apiFetch('/wallet')).wallet,
    enabled,
  });
}

const pageSchema = z.object({
  transactions: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});

export function useWalletTransactions() {
  return useInfiniteQuery({
    queryKey: transactionsKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      pageSchema.parse(
        await apiFetch(
          `/wallet/transactions?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * Starts a (simulated) recharge. Nothing is credited until the outcome is
 * applied. The caller owns the idempotency key: one key per recharge intent,
 * so a double-click or retry can never start two recharges.
 */
export function useStartRecharge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      amountPaise,
      idempotencyKey,
    }: {
      amountPaise: number;
      idempotencyKey: string;
    }) =>
      z.object({ recharge: rechargeSchema }).parse(
        await apiFetch('/wallet/recharges', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ amountPaise }),
        }),
      ).recharge,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: transactionsKey }),
  });
}

export type MockOutcome = 'SUCCESS' | 'FAILURE' | 'CANCEL';

/** TEST MODE: applies the simulated payment outcome. The server decides what it means. */
export function useSettleMockRecharge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ rechargeId, outcome }: { rechargeId: string; outcome: MockOutcome }) =>
      z
        .object({
          changed: z.boolean(),
          recharge: rechargeSchema,
          wallet: z.object({ balancePaise: z.number().int() }),
        })
        .parse(
          await apiFetch(`/payments/mock/${rechargeId}/outcome`, {
            method: 'POST',
            body: JSON.stringify({ outcome }),
          }),
        ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: walletKey }),
  });
}

export function useRecharge(rechargeId: string | null) {
  return useQuery({
    queryKey: ['wallet', 'recharges', rechargeId],
    queryFn: async () =>
      z
        .object({ recharge: rechargeSchema })
        .parse(await apiFetch(`/wallet/recharges/${rechargeId}`)).recharge,
    enabled: Boolean(rechargeId),
  });
}
