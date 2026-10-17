import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import {
  query,
  quickReorderInfoSchema,
  rankedItemSchema,
  type Dietary,
  type MenuSort,
} from './outlets';

/** The campus-wide menu (GET /menu): search, filters and sorting run on the server, paged. */

export interface CampusMenuFilters {
  q?: string;
  outletId?: string;
  category?: string;
  dietary?: Dietary;
  inStock?: boolean;
  sort?: MenuSort;
}

const pageSchema = z.object({
  items: z.array(rankedItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  hasMore: z.boolean(),
  sort: z.string().nullable(),
  quickReorder: quickReorderInfoSchema,
  popularWindowDays: z.number().int().nullable(),
  filters: z.object({
    outlets: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
    categories: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});
export type CampusMenuPage = z.infer<typeof pageSchema>;

export const PAGE_SIZE = 24;

/** Changing any filter starts again at page 1 (it's part of the key). */
export function useCampusMenu(filters: CampusMenuFilters) {
  return useInfiniteQuery({
    queryKey: ['menu', 'campus', filters],
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) =>
      pageSchema.parse(
        await apiFetch(`/menu${query({ ...filters, page: pageParam, pageSize: PAGE_SIZE })}`, {
          signal,
        }),
      ),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
}
