import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { dietarySchema, stockStatusSchema, type StockStatus } from './outlets';

/*
 * Menu item stock for staff. Every number shown comes from the server; after each change
 * the server's answer replaces what's on screen.
 */

export const inventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageUrl: z.string().nullable(),
  pricePaise: z.number().int(),
  dietary: dietarySchema.nullable(),
  isActive: z.boolean(),
  category: z.object({ id: z.string(), name: z.string(), isActive: z.boolean() }),
  trackInventory: z.boolean(),
  stockQuantity: z.number().int().nullable(),
  lowStockThreshold: z.number().int(),
  soldOutManually: z.boolean(),
  stockStatus: stockStatusSchema,
  soldOutReason: z.enum(['MARKED_SOLD_OUT', 'OUT_OF_STOCK']).nullable(),
  stockUpdatedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

const listSchema = z.object({
  items: z.array(inventoryItemSchema),
  counts: z.object({
    AVAILABLE: z.number().int(),
    LOW_STOCK: z.number().int(),
    SOLD_OUT: z.number().int(),
  }),
});

const historySchema = z.object({
  history: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      quantityChange: z.number().int(),
      previousQuantity: z.number().int().nullable(),
      resultingQuantity: z.number().int().nullable(),
      orderId: z.string().nullable(),
      actor: z.object({ displayName: z.string(), role: z.string().nullable() }).nullable(),
      reason: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type StockHistoryEntry = z.infer<typeof historySchema>['history'][number];

export const inventoryKey = (outletId: string) => ['staff', 'inventory', outletId] as const;
const base = (outletId: string) => `/staff/outlets/${outletId}/inventory`;

export interface InventoryFilters {
  q?: string;
  categoryId?: string;
  status?: StockStatus;
}

export function useInventory(outletId: string, filters: InventoryFilters) {
  return useQuery({
    queryKey: [...inventoryKey(outletId), filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      const query = params.toString();
      return listSchema.parse(await apiFetch(`${base(outletId)}${query ? `?${query}` : ''}`));
    },
    placeholderData: keepPreviousData,
  });
}

export function useStockHistory(outletId: string, itemId: string | null) {
  return useQuery({
    queryKey: [...inventoryKey(outletId), 'history', itemId],
    queryFn: async () =>
      historySchema.parse(await apiFetch(`${base(outletId)}/${itemId}/history`)).history,
    enabled: Boolean(itemId),
  });
}

function useInventoryMutation<TInput>(
  outletId: string,
  request: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) =>
      z.object({ item: inventoryItemSchema }).parse(await request(input)).item,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: inventoryKey(outletId) });
      void queryClient.invalidateQueries({ queryKey: ['staff', 'menu', outletId] });
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
    },
  });
}

export type Adjustment =
  | { type: 'RESTOCK'; quantity: number; reason?: string; markAvailable?: boolean }
  | { type: 'REMOVAL'; quantity: number; reason: string }
  | { type: 'COUNT_SET'; quantity: number; expectedQuantity: number; reason?: string };

export function useAdjustStock(outletId: string) {
  return useInventoryMutation(outletId, ({ itemId, ...body }: Adjustment & { itemId: string }) =>
    apiFetch(`${base(outletId)}/${itemId}/adjustments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

export function useSetThreshold(outletId: string) {
  return useInventoryMutation(
    outletId,
    ({ itemId, lowStockThreshold }: { itemId: string; lowStockThreshold: number }) =>
      apiFetch(`${base(outletId)}/${itemId}/threshold`, {
        method: 'PATCH',
        body: JSON.stringify({ lowStockThreshold }),
      }),
  );
}

export function useSetTracking(outletId: string) {
  return useInventoryMutation(
    outletId,
    ({
      itemId,
      ...body
    }: {
      itemId: string;
      enabled: boolean;
      quantity?: number;
      lowStockThreshold?: number;
    }) =>
      apiFetch(`${base(outletId)}/${itemId}/tracking`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  );
}
