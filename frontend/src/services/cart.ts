import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { dietarySchema, outletStatusSchema, stockStatusSchema } from './outlets';
import { useCurrentUser } from './auth';

export const cartSchema = z.object({
  outlet: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      status: outletStatusSchema,
      acceptingOrders: z.boolean(),
    })
    .nullable(),
  items: z.array(
    z.object({
      menuItemId: z.string(),
      name: z.string(),
      dietary: dietarySchema.nullable(),
      unitPricePaise: z.number().int(),
      quantity: z.number().int(),
      lineTotalPaise: z.number().int(),
      isOrderable: z.boolean(),
      stockStatus: stockStatusSchema,
    }),
  ),
  itemCount: z.number().int(),
  subtotalPaise: z.number().int(),
  totalPaise: z.number().int(),
  issues: z.array(
    z.object({
      menuItemId: z.string(),
      name: z.string(),
      reason: z.enum(['SOLD_OUT', 'NO_LONGER_ON_MENU', 'NOT_ENOUGH_STOCK']),
      /** For NOT_ENOUGH_STOCK: how many can still be ordered. */
      available: z.number().int().optional(),
    }),
  ),
  canCheckout: z.boolean(),
  /** Can be placed for a later pickup slot (even if the outlet is closed right now). */
  canSchedule: z.boolean(),
  /** What checkout would accept now. The server re-checks everything when the order is placed. */
  loyalty: z.object({
    availablePoints: z.number().int(),
    maxRedeemablePoints: z.number().int(),
    pointValuePaise: z.number().int(),
  }),
});
export type Cart = z.infer<typeof cartSchema>;

const cartResponse = z.object({ cart: cartSchema });
export const cartKey = ['cart'] as const;

/** The server's view of the cart. Only fetched for signed-in students. */
export function useCart() {
  const { data: user } = useCurrentUser();
  return useQuery({
    queryKey: cartKey,
    queryFn: async () => cartResponse.parse(await apiFetch('/cart')).cart,
    enabled: Boolean(user?.roles.includes('STUDENT')),
  });
}

function useCartMutation<TInput>(request: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => cartResponse.parse(await request(input)).cart,
    // Every cart endpoint returns the whole updated cart; use it as the new truth.
    onSuccess: (cart) => queryClient.setQueryData(cartKey, cart),
  });
}

export function useAddToCart() {
  return useCartMutation(
    (input: { menuItemId: string; quantity?: number; replaceCart?: boolean }) =>
      apiFetch('/cart/items', { method: 'POST', body: JSON.stringify(input) }),
  );
}

export function useSetQuantity() {
  return useCartMutation((input: { menuItemId: string; quantity: number }) =>
    apiFetch(`/cart/items/${input.menuItemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: input.quantity }),
    }),
  );
}

export function useRemoveFromCart() {
  return useCartMutation((menuItemId: string) =>
    apiFetch(`/cart/items/${menuItemId}`, { method: 'DELETE' }),
  );
}

export function useClearCart() {
  return useCartMutation(() => apiFetch('/cart', { method: 'DELETE' }));
}
