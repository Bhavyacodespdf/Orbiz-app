import type { DbClient } from '../../lib/prisma.js';

/*
 * Rating summaries are always calculated from persisted PUBLISHED reviews — nothing is stored or
 * accepted from a client. average = sum of ratings / number of ratings, kept exact for sorting and
 * rounded half-up to one decimal for display.
 */

export interface RatingSummary {
  /** Rounded to one decimal; null when nobody has rated the item. */
  average: number | null;
  count: number;
}

export interface RatingDetail extends RatingSummary {
  /** How many published reviews gave each star level. */
  distribution: { stars: 1 | 2 | 3 | 4 | 5; count: number }[];
}

export const NO_RATINGS: RatingSummary = { average: null, count: 0 };

/** Half-up to one decimal, e.g. 4.25 → 4.3, 4.24 → 4.2. */
export function roundRating(value: number): number {
  return Math.round(value * 10 + Number.EPSILON) / 10;
}

export function summarize(sum: number, count: number): RatingSummary {
  return count === 0 ? NO_RATINGS : { average: roundRating(sum / count), count };
}

/** Exact average for ordering (unrated items sort last). */
export const exactAverage = (sum: number, count: number) => (count === 0 ? -1 : sum / count);

/** Summaries for many items in one grouped query; items without reviews get NO_RATINGS. */
export async function ratingSummaries(
  db: DbClient,
  menuItemIds: string[],
): Promise<Map<string, RatingSummary & { exact: number }>> {
  const result = new Map<string, RatingSummary & { exact: number }>();
  if (menuItemIds.length === 0) return result;
  const groups = await db.foodReview.groupBy({
    by: ['menuItemId'],
    where: { menuItemId: { in: menuItemIds }, status: 'PUBLISHED' },
    _sum: { rating: true },
    _count: { _all: true },
  });
  for (const id of menuItemIds) result.set(id, { ...NO_RATINGS, exact: -1 });
  for (const g of groups) {
    const sum = g._sum.rating ?? 0;
    const count = g._count._all;
    result.set(g.menuItemId, { ...summarize(sum, count), exact: exactAverage(sum, count) });
  }
  return result;
}

/** Summary plus the 1–5 star distribution for one item. */
export async function ratingDetail(db: DbClient, menuItemId: string): Promise<RatingDetail> {
  const groups = await db.foodReview.groupBy({
    by: ['rating'],
    where: { menuItemId, status: 'PUBLISHED' },
    _count: { _all: true },
  });
  const byStars = new Map(groups.map((g) => [g.rating, g._count._all]));
  const distribution = ([5, 4, 3, 2, 1] as const).map((stars) => ({
    stars,
    count: byStars.get(stars) ?? 0,
  }));
  const count = distribution.reduce((s, d) => s + d.count, 0);
  const sum = distribution.reduce((s, d) => s + d.stars * d.count, 0);
  return { ...summarize(sum, count), distribution };
}

/** Attaches `rating` to serialized items (menu rows, combo items…) by id. */
export async function withRatings<T extends { id: string }>(
  db: DbClient,
  items: T[],
): Promise<(T & { rating: RatingSummary })[]> {
  const summaries = await ratingSummaries(
    db,
    items.map((i) => i.id),
  );
  return items.map((item) => {
    const s = summaries.get(item.id);
    return { ...item, rating: s ? { average: s.average, count: s.count } : NO_RATINGS };
  });
}
