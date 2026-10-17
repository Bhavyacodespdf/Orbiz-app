import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { cartKey } from './cart';
import { walletKey } from './wallet';

export const orderStatusSchema = z.enum([
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'NO_SHOW',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** IMMEDIATE = prepared now; SCHEDULED = for a chosen pickup slot (₹10 fee, set by the server). */
export const orderTimingSchema = z.enum(['IMMEDIATE', 'SCHEDULED']);
const timingFields = {
  timing: orderTimingSchema,
  scheduledFor: z.string().nullable(),
  scheduledFeePaise: z.number().int(),
};

export const orderSchema = z.object({
  id: z.string(),
  pickupCode: z.string(),
  outlet: z.object({ id: z.string(), slug: z.string(), name: z.string(), location: z.string() }),
  status: orderStatusSchema,
  paymentMethod: z.enum(['WALLET', 'COUNTER', 'GROUP']),
  paymentStatus: z.enum(['PENDING_COUNTER', 'PAID', 'REFUNDED', 'VOID', 'PARTIALLY_REFUNDED']),
  items: z.array(
    z.object({
      menuItemId: z.string(),
      name: z.string(),
      unitPricePaise: z.number().int(),
      quantity: z.number().int(),
      lineTotalPaise: z.number().int(),
      /** PACKAGED / HANDMADE as classified when ordered; null = not classified then. */
      fulfillmentType: z.enum(['PACKAGED', 'HANDMADE']).nullable(),
      unsuitableForResale: z.boolean(),
      noShow: z
        .object({
          paidPaise: z.number().int(),
          refundPaise: z.number().int(),
          feePaise: z.number().int(),
          restockedQuantity: z.number().int(),
        })
        .nullable(),
    }),
  ),
  subtotalPaise: z.number().int(),
  pointsRedeemed: z.number().int(),
  pointsDiscountPaise: z.number().int(),
  ...timingFields,
  totalPaise: z.number().int(),
  /** What goes back to the wallet on rejection/cancellation (the server's refund rule). */
  refundPaise: z.number().int(),
  /** Scheduled orders: collect by this time or the no-show policy applies. */
  pickupDeadline: z.string().nullable(),
  noShow: z
    .object({
      status: z.enum(['PROCESSED', 'FAILED']),
      processedAt: z.string().nullable(),
      refundPaise: z.number().int(),
      convenienceFeePaise: z.number().int(),
      scheduledFeeRetainedPaise: z.number().int(),
      restockedUnits: z.number().int(),
    })
    .nullable(),
  currency: z.literal('INR'),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  placedAt: z.string(),
  updatedAt: z.string(),
  statusHistory: z.array(
    z.object({
      fromStatus: orderStatusSchema.nullable(),
      toStatus: orderStatusSchema,
      reason: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type Order = z.infer<typeof orderSchema>;

const orderResponse = z.object({ order: orderSchema });

export function useOrder(orderId: string) {
  return useQuery({
    queryKey: ['orders', orderId],
    queryFn: async () => orderResponse.parse(await apiFetch(`/orders/${orderId}`)).order,
  });
}

/**
 * Places the order. The idempotency key must stay the same for retries of the
 * same checkout, so it is passed in by the page rather than generated here.
 */
export function usePlaceOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      paymentMethod: 'WALLET' | 'COUNTER';
      expectedTotalPaise: number;
      pointsToRedeem: number;
      /** A pickup slot start for a scheduled order; omitted for "order now". */
      scheduledFor?: string;
      idempotencyKey: string;
    }) =>
      orderResponse.parse(
        await apiFetch('/orders', {
          method: 'POST',
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: JSON.stringify({
            paymentMethod: input.paymentMethod,
            expectedTotalPaise: input.expectedTotalPaise,
            pointsToRedeem: input.pointsToRedeem,
            ...(input.scheduledFor && { scheduledFor: input.scheduledFor }),
          }),
        }),
      ).order,
    onSuccess: (order) => {
      queryClient.setQueryData(['orders', order.id], order);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: cartKey });
      void queryClient.invalidateQueries({ queryKey: walletKey });
    },
  });
}

export const orderSummarySchema = z.object({
  id: z.string(),
  pickupCode: z.string(),
  outlet: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  status: orderStatusSchema,
  paymentMethod: z.enum(['WALLET', 'COUNTER', 'GROUP']),
  paymentStatus: z.enum(['PENDING_COUNTER', 'PAID', 'REFUNDED', 'VOID', 'PARTIALLY_REFUNDED']),
  ...timingFields,
  pickupDeadline: z.string().nullable(),
  totalPaise: z.number().int(),
  itemCount: z.number().int(),
  placedAt: z.string(),
  version: z.number().int(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

const orderPageSchema = z.object({
  orders: z.array(orderSummarySchema),
  nextCursor: z.string().nullable(),
});

/** The student's own orders: "active" (in progress) or "past". Kept fresh by live events. */
export function useOrders(view: 'active' | 'past') {
  return useInfiniteQuery({
    queryKey: ['orders', 'list', view],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      orderPageSchema.parse(
        await apiFetch(
          `/orders?view=${view}&limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason?: string }) =>
      orderResponse.parse(
        await apiFetch(`/orders/${orderId}/cancel`, {
          method: 'POST',
          body: JSON.stringify(reason ? { reason } : {}),
        }),
      ).order,
    onSuccess: (order) => {
      queryClient.setQueryData(['orders', order.id], order);
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      void queryClient.invalidateQueries({ queryKey: walletKey });
    },
  });
}

/** Moves the student's own scheduled order to another slot (no extra fee). */
export function useRescheduleOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, scheduledFor }: { orderId: string; scheduledFor: string }) =>
      orderResponse.parse(
        await apiFetch(`/orders/${orderId}/reschedule`, {
          method: 'POST',
          body: JSON.stringify({ scheduledFor }),
        }),
      ).order,
    onSuccess: (order) => {
      queryClient.setQueryData(['orders', order.id], order);
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}
