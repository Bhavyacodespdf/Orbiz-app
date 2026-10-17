import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import type { OrderStatus } from './orders';

/*
 * Kitchen timing: live order tracking for students, configuration and accuracy for managers.
 * Every estimate is approximate and computed on the server from real order records.
 */

const trackingSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  timeline: z.array(
    z.object({ status: z.string(), at: z.string(), reason: z.string().nullable() }),
  ),
  readyAt: z.string().nullable(),
  collectedAt: z.string().nullable(),
  estimate: z
    .object({
      queuePosition: z.number().int().nullable(),
      ordersAhead: z.number().int(),
      predictedReadyAt: z.string(),
      rangeMinutes: z.number().nullable(),
      awaitingAcceptance: z.boolean(),
      updatedAt: z.string(),
    })
    .nullable(),
});
export type Tracking = z.infer<typeof trackingSchema>;

/** Refetched on order/estimate socket events and when the status changes. */
export function useOrderTracking(orderId: string, status: OrderStatus | undefined) {
  return useQuery({
    queryKey: ['orders', orderId, 'tracking', status],
    queryFn: async () =>
      z.object({ tracking: trackingSchema }).parse(await apiFetch(`/orders/${orderId}/tracking`))
        .tracking,
    enabled: Boolean(status),
    // Estimates drift with time; a gentle refresh keeps them honest between events.
    refetchInterval: 60_000,
  });
}

const sourceSchema = z.enum(['HISTORY', 'CONFIGURED', 'DEFAULT']);
export type EstimateSource = z.infer<typeof sourceSchema>;

const kitchenSchema = z.object({
  settings: z.object({
    kitchenParallelOrders: z.number().int(),
    autoAcceptMode: z.enum(['MANUAL', 'AUTO']),
    autoAcceptMaxWaitMinutes: z.number().int(),
  }),
  calibration: z.object({
    factor: z.number(),
    learnedFactor: z.number().nullable(),
    observations: z.number().int(),
  }),
  dishes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      prepMinutes: z.number().int().nullable(),
      prepUpdatedAt: z.string().nullable(),
      history: z
        .object({
          emaMinutes: z.number(),
          observations: z.number().int(),
          lastDurationMinutes: z.number().nullable(),
          lastObservedAt: z.string().nullable(),
        })
        .nullable(),
      estimate: z.object({ minutes: z.number(), source: sourceSchema }),
    }),
  ),
});
export type Kitchen = z.infer<typeof kitchenSchema>;
export type KitchenSettings = Kitchen['settings'];

const kitchenKey = (outletId: string) => ['staff', 'kitchen', outletId] as const;

export function useKitchen(outletId: string) {
  return useQuery({
    queryKey: kitchenKey(outletId),
    queryFn: async () => kitchenSchema.parse(await apiFetch(`/staff/outlets/${outletId}/kitchen`)),
  });
}

export function useUpdatePrepMinutes(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      menuItemId,
      prepMinutes,
    }: {
      menuItemId: string;
      prepMinutes: number | null;
    }) =>
      kitchenSchema.parse(
        await apiFetch(`/staff/outlets/${outletId}/kitchen/items/${menuItemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ prepMinutes }),
        }),
      ),
    onSuccess: (data) => queryClient.setQueryData(kitchenKey(outletId), data),
  });
}

export function useUpdateKitchenSettings(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: KitchenSettings) =>
      kitchenSchema.parse(
        await apiFetch(`/staff/outlets/${outletId}/kitchen/settings`, {
          method: 'PUT',
          body: JSON.stringify(settings),
        }),
      ),
    onSuccess: (data) => queryClient.setQueryData(kitchenKey(outletId), data),
  });
}

const summarySchema = z.object({
  evaluated: z.number().int(),
  meanAbsErrorMinutes: z.number().nullable(),
  medianAbsErrorMinutes: z.number().nullable(),
  withinTolerancePct: z.number().nullable(),
});
const accuracySchema = z.object({
  days: z.number().int(),
  since: z.string(),
  toleranceMinutes: z.number(),
  enoughData: z.boolean(),
  acceptToReady: summarySchema,
  prepStartToReady: summarySchema,
  lateOrders: z.number().int(),
  lateThresholdMinutes: z.number(),
  perDay: z.array(summarySchema.extend({ day: z.string(), ordersPlaced: z.number().int() })),
  autoAccept: z.object({
    ACCEPTED: z.number().int().optional(),
    MANUAL_REVIEW: z.number().int().optional(),
    ALREADY_HANDLED: z.number().int().optional(),
  }),
});
export type Accuracy = z.infer<typeof accuracySchema>;

export function useAccuracy(outletId: string, days: number) {
  return useQuery({
    queryKey: [...kitchenKey(outletId), 'accuracy', days],
    queryFn: async () =>
      z
        .object({ accuracy: accuracySchema })
        .parse(await apiFetch(`/staff/outlets/${outletId}/kitchen/accuracy?days=${days}`)).accuracy,
  });
}
