import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { orderSchema, type OrderStatus } from './orders';

/*
 * Secure pickup verification. The student's code and QR payload come only from
 * GET /orders/:id/pickup (owner only, never cached by the browser). Staff verify a code, see the
 * matched order, and must confirm the handover explicitly — the server re-checks everything.
 */

const pickupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NOT_READY') }),
  z.object({ state: z.literal('ENDED') }),
  z.object({ state: z.literal('EXPIRED'), canRefresh: z.boolean() }),
  z.object({ state: z.literal('COLLECTED'), collectedAt: z.string() }),
  z.object({
    state: z.literal('ACTIVE'),
    code: z.string(),
    qrPayload: z.string(),
    expiresAt: z.string(),
    paymentDuePaise: z.number().int(),
  }),
]);
export type StudentPickup = z.infer<typeof pickupSchema>;

const pickupResponse = z.object({ pickup: pickupSchema });
export const pickupKey = (orderId: string) => ['orders', orderId, 'pickup'] as const;

/** Re-read whenever the order's status changes (READY issues the code, COMPLETED retires it). */
export function useOrderPickup(orderId: string, status: OrderStatus | undefined) {
  return useQuery({
    queryKey: [...pickupKey(orderId), status],
    queryFn: async () => pickupResponse.parse(await apiFetch(`/orders/${orderId}/pickup`)).pickup,
    enabled: Boolean(status),
    staleTime: 0,
    // Don't keep the secret around in memory longer than the screen needs it.
    gcTime: 0,
  });
}

export function useRefreshPickup(orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      pickupResponse.parse(
        await apiFetch(`/orders/${orderId}/pickup/refresh`, { method: 'POST', body: '{}' }),
      ).pickup,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: pickupKey(orderId) }),
  });
}

const verifiedSchema = z.object({
  challengeToken: z.string(),
  expiresAt: z.string(),
  canConfirm: z.boolean(),
  order: z.object({
    id: z.string(),
    pickupCode: z.string(),
    status: z.string(),
    timing: z.enum(['IMMEDIATE', 'SCHEDULED']),
    scheduledFor: z.string().nullable(),
    customer: z.object({ displayName: z.string() }),
    items: z.array(
      z.object({ menuItemId: z.string(), name: z.string(), quantity: z.number().int() }),
    ),
    paymentMethod: z.enum(['WALLET', 'COUNTER', 'GROUP']),
    paymentDuePaise: z.number().int(),
  }),
});
export type VerifiedPickup = z.infer<typeof verifiedSchema>;

export type VerifyRequest = { method: 'CODE'; code: string } | { method: 'QR'; payload: string };

/** Checks a code at this outlet. Nothing is handed over by this call. */
export function useVerifyPickup(outletId: string) {
  return useMutation({
    mutationFn: async (request: VerifyRequest) =>
      verifiedSchema.parse(
        await apiFetch(`/staff/outlets/${outletId}/pickup/verify`, {
          method: 'POST',
          body: JSON.stringify(request),
        }),
      ),
  });
}

const confirmedSchema = z.object({
  order: orderSchema,
  alreadyConfirmed: z.boolean(),
  handover: z
    .object({ handedOverAt: z.string(), handedOverBy: z.string(), method: z.enum(['QR', 'CODE']) })
    .nullable(),
});

/** The explicit handover for a verified code (safe to retry with the same challenge). */
export function useConfirmHandover(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (challengeToken: string) =>
      confirmedSchema.parse(
        await apiFetch(`/staff/outlets/${outletId}/pickup/confirm`, {
          method: 'POST',
          body: JSON.stringify({ challengeToken }),
        }),
      ),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ['staff', 'orders', outletId] }),
  });
}
