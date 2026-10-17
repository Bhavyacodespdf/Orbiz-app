import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';

export const outletStatusSchema = z.enum(['OPEN', 'PAUSED', 'CLOSED']);
export const dietarySchema = z.enum(['VEG', 'NON_VEG', 'EGG']);
/** From the server's stock rules. LOW_STOCK items can still be ordered. */
export const stockStatusSchema = z.enum(['AVAILABLE', 'LOW_STOCK', 'SOLD_OUT']);
export type StockStatus = z.infer<typeof stockStatusSchema>;
export type Dietary = z.infer<typeof dietarySchema>;

export const outletSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  location: z.string(),
  imageUrl: z.string().nullable(),
  status: outletStatusSchema,
  acceptingOrders: z.boolean(),
  isSample: z.boolean(),
});
export type Outlet = z.infer<typeof outletSchema>;

export const categorySchema = z.object({ id: z.string(), name: z.string(), sortOrder: z.number() });
export type Category = z.infer<typeof categorySchema>;

/** From persisted published reviews; average is null when nobody has rated the dish. */
export const ratingSummarySchema = z.object({
  average: z.number().nullable(),
  count: z.number().int(),
});
export type RatingSummary = z.infer<typeof ratingSummarySchema>;

export const menuItemSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Integer paise, straight from the server. Never computed in the browser. */
  pricePaise: z.number().int(),
  dietary: dietarySchema.nullable(),
  /** Orderable right now (not sold out). */
  isAvailable: z.boolean(),
  stockStatus: stockStatusSchema,
  imageUrl: z.string().nullable(),
  rating: ratingSummarySchema,
});
export type MenuItem = z.infer<typeof menuItemSchema>;

/** Popular · Price: Low to High · Price: High to Low · Quick Reorder · Highest Rated. */
export const MENU_SORTS = [
  { value: 'popular', label: 'Popular' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'quick-reorder', label: 'Quick Reorder' },
  { value: 'highest-rated', label: 'Highest Rated' },
] as const;
export type MenuSort = (typeof MENU_SORTS)[number]['value'];
export const isMenuSort = (v: string | null): v is MenuSort =>
  MENU_SORTS.some((s) => s.value === v);

/** A dish in a search/sort result: the menu item plus what the chosen ranking used. */
export const rankedItemSchema = menuItemSchema.extend({
  category: z.object({ id: z.string(), name: z.string() }).optional(),
  outlet: outletSchema.optional(),
  /** Popular only: collected orders in the window. */
  orders30d: z.number().int().nullable().default(null),
  popular: z.boolean().default(false),
  /** Quick Reorder only: the signed-in student's own history for this dish. */
  mine: z.object({ orders: z.number().int(), lastOrderedAt: z.string() }).nullable().default(null),
});
export type RankedItem = z.infer<typeof rankedItemSchema>;

export const quickReorderInfoSchema = z
  .object({ signedIn: z.boolean(), hasHistory: z.boolean(), windowDays: z.number().int() })
  .nullable()
  .default(null);

const outletListSchema = z.object({ outlets: z.array(outletSchema) });
const menuSchema = z.object({
  outlet: outletSchema,
  categories: z.array(categorySchema),
  items: z.array(rankedItemSchema),
  total: z.number().int().optional(),
  sort: z.string().nullable().default(null),
  quickReorder: quickReorderInfoSchema,
  popularWindowDays: z.number().int().nullable().default(null),
});
export type OutletMenu = z.infer<typeof menuSchema>;

export function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function useOutlets(q: string) {
  return useQuery({
    queryKey: ['outlets', { q }],
    queryFn: async () => outletListSchema.parse(await apiFetch(`/outlets${query({ q })}`)).outlets,
    placeholderData: keepPreviousData,
  });
}

export interface MenuFilters {
  q?: string;
  category?: string;
  dietary?: Dietary;
  sort?: MenuSort;
  /** Only dishes that can be ordered right now. */
  inStock?: boolean;
}

export function useOutletMenu(slug: string, filters: MenuFilters) {
  return useQuery({
    queryKey: ['outlets', slug, 'menu', filters],
    // The signal cancels a superseded request, so an old answer never replaces a newer one.
    queryFn: async ({ signal }) =>
      menuSchema.parse(
        await apiFetch(`/outlets/${encodeURIComponent(slug)}/menu${query({ ...filters })}`, {
          signal,
        }),
      ),
    placeholderData: keepPreviousData,
  });
}
