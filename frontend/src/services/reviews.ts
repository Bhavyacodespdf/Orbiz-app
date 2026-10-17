import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { categorySchema, menuItemSchema, outletSchema, ratingSummarySchema } from './outlets';

/*
 * Food ratings & reviews. Every average, count and distribution comes from the server, which
 * calculates them from persisted published reviews; the browser never computes or sends them.
 */

export const feedbackLevelSchema = z.enum(['POOR', 'OKAY', 'GREAT']);
export type FeedbackLevel = z.infer<typeof feedbackLevelSchema>;
export const FEEDBACK_ASPECTS = ['taste', 'portion', 'freshness', 'value'] as const;
export type FeedbackAspect = (typeof FEEDBACK_ASPECTS)[number];

export const ratingDetailSchema = ratingSummarySchema.extend({
  distribution: z.array(z.object({ stars: z.number().int(), count: z.number().int() })),
});
export type RatingDetail = z.infer<typeof ratingDetailSchema>;

const feedbackSchema = z.object({
  taste: feedbackLevelSchema.nullable(),
  portion: feedbackLevelSchema.nullable(),
  freshness: feedbackLevelSchema.nullable(),
  value: feedbackLevelSchema.nullable(),
});
export type Feedback = z.infer<typeof feedbackSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  rating: z.number().int(),
  body: z.string().nullable(),
  feedback: feedbackSchema,
  verifiedPurchase: z.boolean(),
  author: z.string(),
  isMine: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  edited: z.boolean(),
});
export type Review = z.infer<typeof reviewSchema>;

export const ownReviewSchema = reviewSchema.extend({
  status: z.enum(['PUBLISHED', 'HIDDEN']),
  moderationReason: z.string().nullable(),
});
export type OwnReview = z.infer<typeof ownReviewSchema>;

const pageFields = {
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  hasMore: z.boolean(),
};

const itemDetailSchema = z.object({
  item: menuItemSchema.extend({ rating: ratingDetailSchema }),
  category: categorySchema,
  outlet: outletSchema,
});
export type MenuItemDetail = z.infer<typeof itemDetailSchema>;

const reviewPageSchema = z.object({ reviews: z.array(reviewSchema), ...pageFields });
const myReviewSchema = z.object({ eligible: z.boolean(), review: ownReviewSchema.nullable() });
export type MyReview = z.infer<typeof myReviewSchema>;
const myReviewsPageSchema = z.object({
  reviews: z.array(
    ownReviewSchema.extend({
      item: z.object({ id: z.string(), name: z.string(), isActive: z.boolean() }),
      outlet: z.object({ slug: z.string(), name: z.string() }),
    }),
  ),
  ...pageFields,
});
export type MyReviewsPage = z.infer<typeof myReviewsPageSchema>;

export type ReviewSort = 'recent' | 'highest' | 'lowest';

export interface ReviewInput {
  rating: number;
  body: string | null;
  taste: FeedbackLevel | null;
  portion: FeedbackLevel | null;
  freshness: FeedbackLevel | null;
  value: FeedbackLevel | null;
}

export const reviewKeys = {
  item: (itemId: string) => ['menu-items', itemId] as const,
  list: (itemId: string, sort: ReviewSort) => ['menu-items', itemId, 'reviews', sort] as const,
  mine: (itemId: string) => ['menu-items', itemId, 'my-review'] as const,
  myList: ['me', 'reviews'] as const,
  staff: (outletId: string) => ['staff', outletId, 'reviews'] as const,
};

const PAGE_SIZE = 10;

export function useMenuItem(itemId: string) {
  return useQuery({
    queryKey: reviewKeys.item(itemId),
    queryFn: async () => itemDetailSchema.parse(await apiFetch(`/menu-items/${itemId}`)),
  });
}

/** Published reviews, ten at a time ("Show more" loads the next page). */
export function useItemReviews(itemId: string, sort: ReviewSort) {
  return useInfiniteQuery({
    queryKey: reviewKeys.list(itemId, sort),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      reviewPageSchema.parse(
        await apiFetch(
          `/menu-items/${itemId}/reviews?sort=${sort}&page=${pageParam}&pageSize=${PAGE_SIZE}`,
        ),
      ),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

/** Whether the signed-in student can review the dish, and their review if any. */
export function useMyReview(itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.mine(itemId),
    queryFn: async () => myReviewSchema.parse(await apiFetch(`/menu-items/${itemId}/my-review`)),
    enabled,
  });
}

export function useMyReviews() {
  return useInfiniteQuery({
    queryKey: reviewKeys.myList,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      myReviewsPageSchema.parse(
        await apiFetch(`/me/reviews?page=${pageParam}&pageSize=${PAGE_SIZE}`),
      ),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

/** After any change: the dish, its reviews, my reviews and every menu showing its rating. */
function useRefreshReviews() {
  const queryClient = useQueryClient();
  return (itemId?: string) => {
    if (itemId) void queryClient.invalidateQueries({ queryKey: reviewKeys.item(itemId) });
    else void queryClient.invalidateQueries({ queryKey: ['menu-items'] });
    void queryClient.invalidateQueries({ queryKey: reviewKeys.myList });
    void queryClient.invalidateQueries({ queryKey: ['outlets'] });
  };
}

export function useSaveReview(itemId: string) {
  const refresh = useRefreshReviews();
  return useMutation({
    mutationFn: async ({ reviewId, input }: { reviewId: string | null; input: ReviewInput }) =>
      reviewId
        ? apiFetch(`/reviews/${reviewId}`, { method: 'PATCH', body: JSON.stringify(input) })
        : apiFetch(`/menu-items/${itemId}/reviews`, {
            method: 'POST',
            body: JSON.stringify(input),
          }),
    onSettled: () => refresh(itemId),
  });
}

export function useDeleteReview(itemId?: string) {
  const refresh = useRefreshReviews();
  return useMutation({
    mutationFn: async (reviewId: string) => apiFetch(`/reviews/${reviewId}`, { method: 'DELETE' }),
    onSettled: () => refresh(itemId),
  });
}

export const REPORT_REASONS = [
  { value: 'OFFENSIVE', label: 'Offensive or abusive' },
  { value: 'SPAM', label: 'Spam or advertising' },
  { value: 'NOT_ABOUT_FOOD', label: 'Not about the food' },
  { value: 'PERSONAL_INFO', label: 'Shares personal information' },
  { value: 'OTHER', label: 'Something else' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['value'];

export function useReportReview() {
  return useMutation({
    mutationFn: async ({ reviewId, reason }: { reviewId: string; reason: ReportReason }) =>
      apiFetch(`/reviews/${reviewId}/report`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
  });
}

// ─── Manager ────────────────────────────────────────────────────────────────

const trendSchema = z.enum(['IMPROVING', 'DECLINING', 'STEADY', 'NOT_ENOUGH_DATA']);
export type Trend = z.infer<typeof trendSchema>;

const outletSummarySchema = z.object({
  average: z.number().nullable(),
  total: z.number().int(),
  distribution: z.array(z.object({ stars: z.number().int(), count: z.number().int() })),
  openReports: z.number().int(),
  trendWindowDays: z.number().int(),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      average: z.number(),
      count: z.number().int(),
      recentAverage: z.number().nullable(),
      priorAverage: z.number().nullable(),
      trend: trendSchema,
    }),
  ),
  recentFeedback: z.array(
    reviewSchema.extend({ item: z.object({ id: z.string(), name: z.string() }) }),
  ),
});
export type OutletReviewSummary = z.infer<typeof outletSummarySchema>;

export type OutletReviewFilter = 'reported' | 'hidden' | 'all';
const staffReviewPageSchema = z.object({
  reviews: z.array(
    reviewSchema.extend({
      status: z.enum(['PUBLISHED', 'HIDDEN']),
      moderationReason: z.string().nullable(),
      moderatedAt: z.string().nullable(),
      item: z.object({ id: z.string(), name: z.string() }),
      openReports: z.number().int(),
      reportReasons: z.array(z.string()),
    }),
  ),
  ...pageFields,
});
export type StaffReview = z.infer<typeof staffReviewPageSchema>['reviews'][number];

export function useOutletReviewSummary(outletId: string) {
  return useQuery({
    queryKey: [...reviewKeys.staff(outletId), 'summary'],
    queryFn: async () =>
      z
        .object({ summary: outletSummarySchema })
        .parse(await apiFetch(`/staff/outlets/${outletId}/reviews/summary`)).summary,
  });
}

export function useOutletReviews(outletId: string, filter: OutletReviewFilter) {
  return useInfiniteQuery({
    queryKey: [...reviewKeys.staff(outletId), 'list', filter],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      staffReviewPageSchema.parse(
        await apiFetch(
          `/staff/outlets/${outletId}/reviews?filter=${filter}&page=${pageParam}&pageSize=${PAGE_SIZE}`,
        ),
      ),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

export type ModerationAction = 'hide' | 'restore' | 'keep';

export function useModerateReview(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      reviewId,
      action,
      reason,
    }: {
      reviewId: string;
      action: ModerationAction;
      reason?: string;
    }) =>
      apiFetch(`/staff/outlets/${outletId}/reviews/${reviewId}/${action}`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.staff(outletId) });
      void queryClient.invalidateQueries({ queryKey: ['menu-items'] });
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
    },
  });
}
