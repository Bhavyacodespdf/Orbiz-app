import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { cartKey, cartSchema } from './cart';
import {
  dietarySchema,
  outletStatusSchema,
  ratingSummarySchema,
  stockStatusSchema,
} from './outlets';

/*
 * Quick Reorder and favourite combos. Every price, total, availability status and count comes
 * from the server, which reads live menu data and the student's own order records.
 */

export const lineStatusSchema = z.enum([
  'AVAILABLE',
  'LIMITED',
  'SOLD_OUT',
  'NO_LONGER_ON_MENU',
  'OUTLET_UNAVAILABLE',
]);
export type LineStatus = z.infer<typeof lineStatusSchema>;

const alternativeSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  pricePaise: z.number().int(),
  outlet: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
});
export type Alternative = z.infer<typeof alternativeSchema>;

export const reorderLineSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  imageUrl: z.string().nullable(),
  dietary: dietarySchema.nullable(),
  categoryName: z.string().nullable(),
  stockStatus: stockStatusSchema,
  rating: ratingSummarySchema,
  requestedQuantity: z.number().int(),
  addableQuantity: z.number().int(),
  status: lineStatusSchema,
  limitReason: z.enum(['STOCK', 'QUANTITY_LIMIT']).optional(),
  historicalUnitPricePaise: z.number().int().nullable(),
  currentUnitPricePaise: z.number().int().nullable(),
  priceChanged: z.boolean(),
  alternatives: z.array(alternativeSchema),
  elsewhere: z.array(alternativeSchema),
});
export type ReorderLine = z.infer<typeof reorderLineSchema>;

const evaluatedFields = {
  outlet: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      status: outletStatusSchema,
      acceptingOrders: z.boolean(),
    })
    .nullable(),
  lines: z.array(reorderLineSchema),
  addableCount: z.number().int(),
  currentTotalPaise: z.number().int(),
  historicalTotalPaise: z.number().int().nullable(),
  unchanged: z.boolean(),
};

const historyCardSchema = z.object({
  orderId: z.string(),
  label: z.string(),
  placedAt: z.string(),
  pickupCode: z.string(),
  previousTotalPaise: z.number().int(),
  timesOrdered: z.number().int(),
  ...evaluatedFields,
});
export type HistoryCard = z.infer<typeof historyCardSchema>;

const comboSchema = z.object({
  key: z.string(),
  kind: z.enum(['BASKET', 'PAIR', 'SINGLE']),
  name: z.string(),
  explanation: z.string(),
  pattern: z.string().nullable(),
  timesOrdered: z.number().int(),
  lastOrderedAt: z.string(),
  ...evaluatedFields,
});
export type FavoriteCombo = z.infer<typeof comboSchema>;

const popularSchema = z.object({
  key: z.string(),
  name: z.string(),
  explanation: z.string(),
  students: z.number().int(),
  ...evaluatedFields,
});
export type PopularPick = z.infer<typeof popularSchema>;

const savedComboSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ...evaluatedFields,
});
export type SavedCombo = z.infer<typeof savedComboSchema>;

export const previewSchema = z.object({
  source: z
    .union([
      z.object({ type: z.literal('ORDER'), orderId: z.string() }),
      z.object({ type: z.literal('SAVED_COMBO'), savedComboId: z.string() }),
    ])
    .nullable(),
  ...evaluatedFields,
});
export type ReorderPreview = z.infer<typeof previewSchema>;

export type PreviewRequest =
  | { orderId: string }
  | { savedComboId: string }
  | { items: { menuItemId: string; quantity: number }[] };

export type ReorderSource =
  | { type: 'ORDER'; orderId: string }
  | { type: 'SAVED_COMBO'; savedComboId: string }
  | { type: 'SUGGESTED_COMBO' }
  | { type: 'POPULAR' };

export const reorderKeys = {
  history: ['reorder', 'history'] as const,
  combos: ['reorder', 'combos'] as const,
  saved: ['saved-combos'] as const,
};

export function useReorderHistory(enabled: boolean) {
  return useQuery({
    queryKey: reorderKeys.history,
    queryFn: async () =>
      z
        .object({ windowDays: z.number().int(), orders: z.array(historyCardSchema) })
        .parse(await apiFetch('/reorder/history?limit=6')),
    enabled,
  });
}

export function useFavoriteCombos(enabled: boolean) {
  return useQuery({
    queryKey: reorderKeys.combos,
    queryFn: async () =>
      z
        .object({
          windowDays: z.number().int(),
          personalized: z.boolean(),
          combos: z.array(comboSchema),
          popular: z.array(popularSchema),
        })
        .parse(await apiFetch('/reorder/combos')),
    enabled,
  });
}

export function useSavedCombos(enabled: boolean) {
  return useQuery({
    queryKey: reorderKeys.saved,
    queryFn: async () =>
      z.object({ combos: z.array(savedComboSchema) }).parse(await apiFetch('/saved-combos')).combos,
    enabled,
  });
}

/** Read-only check of what a reorder would add right now. */
export function usePreviewReorder() {
  return useMutation({
    mutationFn: async (request: PreviewRequest) =>
      z
        .object({ preview: previewSchema })
        .parse(
          await apiFetch('/reorder/preview', { method: 'POST', body: JSON.stringify(request) }),
        ).preview,
  });
}

/** Adds reviewed dishes to the existing cart (server re-checks; a retried key adds nothing). */
export function useReorderIntoCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      items: { menuItemId: string; quantity: number }[];
      expectedTotalPaise: number;
      replaceCart: boolean;
      source: ReorderSource;
      idempotencyKey: string;
    }) =>
      z.object({ cart: cartSchema, added: z.boolean() }).parse(
        await apiFetch('/reorder/cart', {
          method: 'POST',
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: JSON.stringify({
            items: input.items,
            expectedTotalPaise: input.expectedTotalPaise,
            replaceCart: input.replaceCart,
            source: input.source,
          }),
        }),
      ),
    onSuccess: ({ cart }) => queryClient.setQueryData(cartKey, cart),
  });
}

export function useSaveCombo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      comboId: string | null;
      name: string;
      items: { menuItemId: string; quantity: number }[];
    }) =>
      input.comboId
        ? apiFetch(`/saved-combos/${input.comboId}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: input.name, items: input.items }),
          })
        : apiFetch('/saved-combos', {
            method: 'POST',
            body: JSON.stringify({ name: input.name, items: input.items }),
          }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: reorderKeys.saved }),
  });
}

export function useDeleteSavedCombo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (comboId: string) =>
      apiFetch(`/saved-combos/${comboId}`, { method: 'DELETE' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: reorderKeys.saved }),
  });
}

/** Live quote for a customised list of dishes (re-runs as the student edits it). */
export function useReorderQuote(items: { menuItemId: string; quantity: number }[]) {
  return useQuery({
    queryKey: ['reorder', 'quote', items],
    queryFn: async () =>
      z
        .object({ preview: previewSchema })
        .parse(
          await apiFetch('/reorder/preview', { method: 'POST', body: JSON.stringify({ items }) }),
        ).preview,
    enabled: items.length > 0,
    placeholderData: keepPreviousData,
  });
}
