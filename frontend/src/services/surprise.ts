import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { cartKey, cartSchema } from './cart';
import { dietarySchema, ratingSummarySchema } from './outlets';

/*
 * AI Surprise Meal — Budget Solver. The server builds every combo from the live menu
 * and enforces the budget, outlet, availability and dietary rules; this module only
 * asks and shows. Nothing here computes a price or a total.
 */

export const moodSchema = z.enum(['QUICK_BITE', 'HIGH_PROTEIN', 'CAFE_TREAT', 'FEAST']);
export type Mood = z.infer<typeof moodSchema>;
export const dietSchema = z.enum(['ANY', 'VEG', 'NON_VEG']);
export type Diet = z.infer<typeof dietSchema>;

const optionsSchema = z.object({
  budget: z.object({
    minPaise: z.number().int(),
    maxPaise: z.number().int(),
    stepPaise: z.number().int(),
    presets: z.array(z.object({ label: z.string(), budgetPaise: z.number().int() })),
  }),
  moods: z.array(moodSchema),
  diets: z.array(dietSchema),
  aiAvailable: z.boolean(),
});
export type SurpriseOptions = z.infer<typeof optionsSchema>;

export const comboItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  pricePaise: z.number().int(),
  dietary: dietarySchema.nullable(),
  imageUrl: z.string().nullable(),
  category: z.object({ id: z.string(), name: z.string() }),
  rating: ratingSummarySchema,
});
export type ComboItem = z.infer<typeof comboItemSchema>;

export const comboSchema = z.object({
  source: z.enum(['RULES', 'AI']),
  outlet: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  items: z.array(comboItemSchema),
  itemCount: z.number().int(),
  totalPaise: z.number().int(),
  budgetPaise: z.number().int(),
  remainingPaise: z.number().int(),
  reasons: z.array(z.string()),
  nutrition: z.object({ available: z.literal(false), note: z.string() }),
});
export type Combo = z.infer<typeof comboSchema>;

const reasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  cheapestPaise: z.number().int().optional(),
});

const generateResponse = z.object({
  combo: comboSchema.nullable(),
  reason: reasonSchema.nullable(),
  notices: z.array(z.string()),
});
export type GenerateResult = z.infer<typeof generateResponse>;

const swapResponse = z.object({
  swapped: z.boolean(),
  message: z.string(),
  combo: comboSchema,
  notices: z.array(z.string()),
});

export interface Preferences {
  budgetPaise: number;
  mood: Mood;
  diet: Diet;
  /** null = all outlets (the combo still comes from one outlet: carts hold one outlet). */
  outletId: string | null;
}

export function useSurpriseOptions() {
  return useQuery({
    queryKey: ['surprise-meal', 'options'],
    queryFn: async () => optionsSchema.parse(await apiFetch('/surprise-meal/options')),
    staleTime: Infinity,
  });
}

export function useGenerateCombo() {
  return useMutation({
    mutationFn: async (input: Preferences & { avoidItemIds: string[] }) =>
      generateResponse.parse(
        await apiFetch('/surprise-meal/generate', { method: 'POST', body: JSON.stringify(input) }),
      ),
  });
}

export function useSwapComboItem() {
  return useMutation({
    mutationFn: async (input: Preferences & { itemIds: string[]; replaceItemId: string }) =>
      swapResponse.parse(
        await apiFetch('/surprise-meal/swap', { method: 'POST', body: JSON.stringify(input) }),
      ),
  });
}

/**
 * Adds the whole combo to the existing cart in one request. The server re-checks prices
 * and availability; the same idempotency key never adds the combo twice.
 */
export function useAddComboToCart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { combo: Combo; replaceCart: boolean; idempotencyKey: string }) =>
      z.object({ cart: cartSchema, added: z.boolean() }).parse(
        await apiFetch('/cart/combo', {
          method: 'POST',
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: JSON.stringify({
            items: input.combo.items.map((i) => ({ menuItemId: i.id, quantity: 1 })),
            expectedTotalPaise: input.combo.totalPaise,
            replaceCart: input.replaceCart,
          }),
        }),
      ),
    onSuccess: ({ cart }) => queryClient.setQueryData(cartKey, cart),
  });
}
