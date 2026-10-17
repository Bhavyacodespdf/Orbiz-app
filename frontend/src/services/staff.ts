import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { categorySchema, menuItemSchema, outletSchema, type Dietary } from './outlets';
import { orderSchema, orderStatusSchema, orderSummarySchema, type OrderStatus } from './orders';

/*
 * Staff (Manager / POS) API. Every call is checked on the server against the
 * user's live role AND their assignment to the outlet; the UI only hides what
 * the server would refuse anyway.
 */

export const staffRoleSchema = z.enum(['MANAGER', 'POS']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

const staffOutletsSchema = z.object({
  outlets: z.array(z.object({ outlet: outletSchema, roles: z.array(staffRoleSchema) })),
});
export type StaffOutlet = z.infer<typeof staffOutletsSchema>['outlets'][number];

export function useStaffOutlets() {
  return useQuery({
    queryKey: ['staff', 'outlets'],
    queryFn: async () => staffOutletsSchema.parse(await apiFetch('/staff/outlets')).outlets,
  });
}

export const staffOrderSummarySchema = orderSummarySchema.extend({
  customer: z.object({ displayName: z.string() }),
  /** Approximate queue estimate for kitchen work (null once ready or finished). */
  estimate: z
    .object({
      queuePosition: z.number().int().nullable(),
      ordersAhead: z.number().int(),
      prepMinutes: z.number(),
      predictedStartAt: z.string().nullable(),
      predictedReadyAt: z.string(),
      delayed: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type StaffOrderSummary = z.infer<typeof staffOrderSummarySchema>;

export const staffOrderSchema = orderSchema.extend({
  customer: z.object({ displayName: z.string() }),
  counterPayment: z
    .object({ amountPaise: z.number().int(), recordedAt: z.string(), recordedBy: z.string() })
    .nullable(),
  allowedNextStatuses: z.array(orderStatusSchema),
  canRecordPayment: z.boolean(),
});
export type StaffOrder = z.infer<typeof staffOrderSchema>;

const ordersKey = (outletId: string) => ['staff', 'orders', outletId] as const;

/** Narrows the live queue to orders for now, scheduled ones, or scheduled ones by due time. */
export type QueueFilter = 'ALL' | 'IMMEDIATE' | 'SCHEDULED' | 'UPCOMING' | 'PAST_DUE';
const FILTER_QUERY: Record<QueueFilter, string> = {
  ALL: '',
  IMMEDIATE: '&timing=IMMEDIATE',
  SCHEDULED: '&timing=SCHEDULED',
  UPCOMING: '&due=upcoming',
  PAST_DUE: '&due=past_due',
};

/**
 * The live queue: everything not yet finished, in the order food is due (a scheduled
 * order counts from its slot). Refreshed by real-time events.
 */
export function useStaffQueue(outletId: string | undefined, filter: QueueFilter = 'ALL') {
  return useQuery({
    queryKey: [...ordersKey(outletId ?? ''), 'active', filter],
    queryFn: async () =>
      z
        .object({ orders: z.array(staffOrderSummarySchema) })
        .parse(
          await apiFetch(
            `/staff/outlets/${outletId}/orders?view=active&limit=100${FILTER_QUERY[filter]}`,
          ),
        ).orders,
    enabled: Boolean(outletId),
  });
}

export function useStaffHistory(outletId: string | undefined) {
  return useInfiniteQuery({
    queryKey: [...ordersKey(outletId ?? ''), 'history'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      z
        .object({ orders: z.array(staffOrderSummarySchema), nextCursor: z.string().nullable() })
        .parse(
          await apiFetch(
            `/staff/outlets/${outletId}/orders?view=history&limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
          ),
        ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(outletId),
  });
}

export function useStaffOrder(outletId: string, orderId: string | null) {
  return useQuery({
    queryKey: [...ordersKey(outletId), 'detail', orderId],
    queryFn: async () =>
      z
        .object({ order: staffOrderSchema })
        .parse(await apiFetch(`/staff/outlets/${outletId}/orders/${orderId}`)).order,
    enabled: Boolean(orderId),
  });
}

function useInvalidateOrders(outletId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ordersKey(outletId) });
}

export function useTransitionOrder(outletId: string) {
  const invalidate = useInvalidateOrders(outletId);
  return useMutation({
    mutationFn: async ({
      orderId,
      to,
      reason,
    }: {
      orderId: string;
      to: OrderStatus;
      reason?: string;
    }) =>
      apiFetch(`/staff/outlets/${outletId}/orders/${orderId}/transition`, {
        method: 'POST',
        body: JSON.stringify(reason ? { to, reason } : { to }),
      }),
    onSettled: invalidate,
  });
}

/** POS: record money physically received at the counter. The amount must equal the order total. */
export function useRecordCounterPayment(outletId: string) {
  const invalidate = useInvalidateOrders(outletId);
  return useMutation({
    mutationFn: async ({
      orderId,
      amountPaise,
      note,
    }: {
      orderId: string;
      amountPaise: number;
      note?: string;
    }) =>
      apiFetch(`/staff/outlets/${outletId}/orders/${orderId}/counter-payment`, {
        method: 'POST',
        body: JSON.stringify(note ? { amountPaise, note } : { amountPaise }),
      }),
    onSettled: invalidate,
  });
}

// ─── Menu management ─────────────────────────────────────────────────────────

export const staffCategorySchema = categorySchema.extend({ isActive: z.boolean() });
export type StaffCategory = z.infer<typeof staffCategorySchema>;
export const staffItemSchema = menuItemSchema.omit({ rating: true }).extend({
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  /** The staff "sold out" switch; stays on until staff restore the item. */
  soldOutManually: z.boolean(),
  /** PACKAGED / HANDMADE for the no-show policy; null = not classified yet. */
  fulfillmentType: z.enum(['PACKAGED', 'HANDMADE']).nullable(),
  trackInventory: z.boolean(),
  stockQuantity: z.number().int().nullable(),
  lowStockThreshold: z.number().int(),
  stockUpdatedAt: z.string().nullable(),
});
export type StaffMenuItem = z.infer<typeof staffItemSchema>;

const staffMenuSchema = z.object({
  outlet: outletSchema.extend({ isActive: z.boolean() }),
  categories: z.array(staffCategorySchema),
  items: z.array(staffItemSchema),
});
export type StaffMenu = z.infer<typeof staffMenuSchema>;

const menuKey = (outletId: string) => ['staff', 'menu', outletId] as const;

export function useStaffMenu(outletId: string | undefined) {
  return useQuery({
    queryKey: menuKey(outletId ?? ''),
    queryFn: async () => staffMenuSchema.parse(await apiFetch(`/staff/outlets/${outletId}/menu`)),
    enabled: Boolean(outletId),
  });
}

function useMenuMutation<TInput>(outletId: string, request: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: menuKey(outletId) });
      void queryClient.invalidateQueries({ queryKey: ['staff', 'inventory', outletId] });
      // Students browsing this outlet should see the change on their next fetch.
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
      void queryClient.invalidateQueries({ queryKey: ['staff', 'outlets'] });
    },
  });
}

export function useSetOutletStatus(outletId: string) {
  return useMenuMutation(outletId, (status: 'OPEN' | 'PAUSED' | 'CLOSED') =>
    apiFetch(`/staff/outlets/${outletId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  );
}

export function useCreateCategory(outletId: string) {
  return useMenuMutation(outletId, (input: { name: string }) =>
    apiFetch(`/staff/outlets/${outletId}/categories`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
}

export function useUpdateCategory(outletId: string) {
  return useMenuMutation(
    outletId,
    ({
      categoryId,
      ...changes
    }: {
      categoryId: string;
      name?: string;
      isActive?: boolean;
      sortOrder?: number;
    }) =>
      apiFetch(`/staff/outlets/${outletId}/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      }),
  );
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  dietary: Dietary | null;
  /** Packaged or handmade (scheduled-order no-show policy). Chosen by the manager. */
  fulfillmentType: 'PACKAGED' | 'HANDMADE';
}

export function useCreateItem(outletId: string) {
  return useMenuMutation(outletId, (input: ItemInput) =>
    apiFetch(`/staff/outlets/${outletId}/items`, { method: 'POST', body: JSON.stringify(input) }),
  );
}

export function useUpdateItem(outletId: string) {
  return useMenuMutation(
    outletId,
    ({ itemId, ...changes }: Partial<ItemInput> & { itemId: string; isActive?: boolean }) =>
      apiFetch(`/staff/outlets/${outletId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      }),
  );
}

export function useSetAvailability(outletId: string) {
  return useMenuMutation(
    outletId,
    ({ itemId, isAvailable }: { itemId: string; isAvailable: boolean }) =>
      apiFetch(`/staff/outlets/${outletId}/items/${itemId}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ isAvailable }),
      }),
  );
}

/** Flag a packaged line of a scheduled order as not fit to resell (it won't be restocked). */
export function useMarkNotResellable(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orderId,
      menuItemId,
      reason,
    }: {
      orderId: string;
      menuItemId: string;
      reason: string;
    }) =>
      apiFetch(`/staff/outlets/${outletId}/orders/${orderId}/items/${menuItemId}/not-resellable`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ordersKey(outletId) }),
  });
}
