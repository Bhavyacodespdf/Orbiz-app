import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { walletKey } from './wallet';

/* Peer splits: repaying a friend who paid for something shared, wallet to wallet. */

const participantStatus = z.enum(['OWNER', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']);
export type ParticipantStatus = z.infer<typeof participantStatus>;

export const splitSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  totalPaise: z.number().int(),
  currency: z.string(),
  method: z.enum(['EQUAL', 'PERCENTAGE', 'CUSTOM']),
  status: z.enum(['OPEN', 'SETTLED', 'CANCELLED']),
  expenseDate: z.string(),
  dueDate: z.string().nullable(),
  owner: z.object({ id: z.string(), displayName: z.string() }),
  isOwner: z.boolean(),
  participants: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
      amountDuePaise: z.number().int(),
      amountPaidPaise: z.number().int(),
      outstandingPaise: z.number().int(),
      status: participantStatus,
    }),
  ),
  myShare: z
    .object({
      amountDuePaise: z.number().int(),
      amountPaidPaise: z.number().int(),
      outstandingPaise: z.number().int(),
      status: participantStatus,
    })
    .nullable(),
  totalOutstandingPaise: z.number().int(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settlements: z
    .array(
      z.object({
        id: z.string(),
        payer: z.string(),
        amountPaise: z.number().int(),
        status: z.enum(['COMPLETED', 'REVERSED']),
        transactionId: z.string(),
        createdAt: z.string(),
        reversedAt: z.string().nullable(),
      }),
    )
    .optional(),
});
export type Split = z.infer<typeof splitSchema>;

export const splitsKey = ['splits'] as const;
const one = z.object({ split: splitSchema });

export function useSplits() {
  return useQuery({
    queryKey: [...splitsKey, 'list'],
    queryFn: async () =>
      z.object({ splits: z.array(splitSchema) }).parse(await apiFetch('/splits')).splits,
  });
}

export function useSplit(splitId: string | null) {
  return useQuery({
    queryKey: [...splitsKey, splitId],
    queryFn: async () => one.parse(await apiFetch(`/splits/${splitId}`)).split,
    enabled: Boolean(splitId),
  });
}

function useSplitMutation<T>(request: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => one.parse(await request(input)).split,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: splitsKey });
      void queryClient.invalidateQueries({ queryKey: walletKey });
    },
  });
}

export interface NewSplit {
  title: string;
  description?: string;
  totalPaise: number;
  expenseDate: string;
  dueDate?: string | null;
  method: 'EQUAL' | 'PERCENTAGE' | 'CUSTOM';
  participants: { email: string; percentBps?: number; customAmountPaise?: number }[];
}

export const useCreateSplit = () =>
  useSplitMutation((input: NewSplit) =>
    apiFetch('/splits', { method: 'POST', body: JSON.stringify(input) }),
  );

export const useSettleSplit = (splitId: string) =>
  useSplitMutation(
    ({ amountPaise, idempotencyKey }: { amountPaise: number; idempotencyKey: string }) =>
      apiFetch(`/splits/${splitId}/settlements`, {
        method: 'POST',
        body: JSON.stringify({ amountPaise }),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
  );

export const useCancelSplit = (splitId: string) =>
  useSplitMutation((reason: string) =>
    apiFetch(`/splits/${splitId}/cancel`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  );
