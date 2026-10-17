import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { BadgeCheck, Flag, MessageSquareText, PencilLine, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { Panel } from '@/components/ui/Panel';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/feedback/Skeleton';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatDateTime } from '@/lib/time';
import { useCurrentUser } from '@/services/auth';
import {
  REPORT_REASONS,
  useDeleteReview,
  useItemReviews,
  useMyReview,
  useReportReview,
  type RatingDetail,
  type ReportReason,
  type Review,
  type ReviewSort,
} from '@/services/reviews';
import { StarRow } from './Stars';
import { ReviewFormDialog } from './ReviewFormDialog';
import {
  STAR_LABELS,
  feedbackParts,
  formatAverage,
  formatDate,
  ratingSentence,
  ratingsLabel,
} from './review-labels';

/** Average, count and the 1–5 star bars. */
export function RatingBreakdown({ rating }: { rating: RatingDetail }) {
  if (rating.average === null) return null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
      <div className="flex flex-col gap-1">
        <p className="font-display text-5xl font-extrabold tabular" aria-hidden>
          {formatAverage(rating.average)}
        </p>
        <StarRow value={rating.average} />
        <p className="text-sm text-espresso-500">
          <span className="sr-only">{ratingSentence(rating)}</span>
          <span aria-hidden>{ratingsLabel(rating.count)}</span>
        </p>
      </div>
      <ul className="flex flex-1 flex-col gap-1.5" aria-label="Ratings by stars">
        {rating.distribution.map(({ stars, count }) => {
          const pct = rating.count ? Math.round((count / rating.count) * 100) : 0;
          return (
            <li key={stars} className="flex items-center gap-2 text-sm">
              <span className="w-14 shrink-0 text-espresso-700">
                {stars} {stars === 1 ? 'star' : 'stars'}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-espresso-50" aria-hidden>
                <span
                  className="block h-full rounded-full bg-mustard-500"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-espresso-500 tabular">
                <span className="sr-only">: </span>
                {count}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One review. User text is rendered as plain text (React escapes it). */
export function ReviewCard({
  review,
  actions,
}: {
  review: Pick<
    Review,
    | 'rating'
    | 'body'
    | 'feedback'
    | 'verifiedPurchase'
    | 'author'
    | 'createdAt'
    | 'edited'
    | 'updatedAt'
  >;
  actions?: ReactNode;
}) {
  const parts = feedbackParts(review.feedback);
  return (
    <article className="flex flex-col gap-2 border-b border-dashed border-espresso-100 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StarRow value={review.rating} />
        <span className="text-sm font-semibold">
          {review.rating}/5 · {STAR_LABELS[review.rating - 1]}
        </span>
        {review.verifiedPurchase && (
          <Badge tone="success" icon={<BadgeCheck className="size-3.5" aria-hidden />}>
            Verified Purchase
          </Badge>
        )}
      </div>
      {review.body && (
        <p className="break-words whitespace-pre-line text-espresso-900">{review.body}</p>
      )}
      {parts.length > 0 && <p className="text-sm text-espresso-700">{parts.join(' · ')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-espresso-500">
          {review.author} ·{' '}
          <time dateTime={review.createdAt} title={formatDateTime(review.createdAt)}>
            {formatDate(review.createdAt)}
          </time>
          {review.edited && (
            <>
              {' '}
              · edited <time dateTime={review.updatedAt}>{formatDate(review.updatedAt)}</time>
            </>
          )}
        </p>
        {actions}
      </div>
    </article>
  );
}

function ReportButton({ reviewId }: { reviewId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>('OFFENSIVE');
  const report = useReportReview();
  const toast = useToast();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Flag className="size-3.5" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Report
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Report this review"
        description="The outlet’s manager will take a look. Reviews aren’t removed just for being negative."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} data-autofocus>
              Cancel
            </Button>
            <Button
              loading={report.isPending}
              onClick={() =>
                report.mutate(
                  { reviewId, reason },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      toast.show({ tone: 'success', title: 'Thanks — the review was reported' });
                    },
                    onError: (e) =>
                      toast.show({
                        tone: 'error',
                        title: 'Couldn’t report',
                        description: describeError(e),
                      }),
                  },
                )
              }
            >
              Report review
            </Button>
          </>
        }
      >
        <SelectField
          label="What’s wrong with it?"
          value={reason}
          onChange={(e) => setReason(e.target.value as ReportReason)}
        >
          {REPORT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </SelectField>
      </Dialog>
    </>
  );
}

/** Published reviews with sorting and "Show more". */
export function ReviewList({ itemId, canReport }: { itemId: string; canReport: boolean }) {
  const [sort, setSort] = useState<ReviewSort>('recent');
  const reviews = useItemReviews(itemId, sort);
  const all = reviews.data?.pages.flatMap((p) => p.reviews) ?? [];
  const total = reviews.data?.pages[0]?.total ?? 0;

  return (
    <section aria-labelledby="reviews-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="reviews-heading" className="text-xl font-bold">
          Reviews{total > 0 && <span className="text-espresso-500"> ({total})</span>}
        </h2>
        {total > 1 && (
          <SelectField
            label="Sort reviews"
            hideLabel
            value={sort}
            onChange={(e) => setSort(e.target.value as ReviewSort)}
            className="w-44"
          >
            <option value="recent">Most recent</option>
            <option value="highest">Highest rated</option>
            <option value="lowest">Lowest rated</option>
          </SelectField>
        )}
      </div>
      {reviews.isPending ? (
        <div aria-busy className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : reviews.error ? (
        <ErrorState
          title="Couldn’t load reviews"
          error={reviews.error}
          onRetry={() => void reviews.refetch()}
          retrying={reviews.isFetching}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText aria-hidden />}
          title="Be the first to rate this item"
          description="Reviews come from students who’ve collected an order with this dish."
        />
      ) : (
        <>
          <div>
            {all.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                actions={
                  review.isMine ? (
                    <Badge tone="dark">Your review</Badge>
                  ) : canReport ? (
                    <ReportButton reviewId={review.id} />
                  ) : undefined
                }
              />
            ))}
          </div>
          {reviews.hasNextPage && (
            <Button
              variant="secondary"
              className="self-center"
              loading={reviews.isFetchingNextPage}
              onClick={() => void reviews.fetchNextPage()}
            >
              Show more reviews
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** Rate / edit / delete for the signed-in student; sign-in or eligibility notes otherwise. */
export function YourReview({ itemId, itemName }: { itemId: string; itemName: string }) {
  const location = useLocation();
  const { data: user, isPending: userPending } = useCurrentUser();
  const isStudent = Boolean(user?.roles.includes('STUDENT'));
  const mine = useMyReview(itemId, isStudent);
  const remove = useDeleteReview(itemId);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (userPending) return <Skeleton className="h-24 w-full" />;
  if (!user) {
    return (
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-espresso-700">Ordered this? Sign in to rate it.</p>
        <ButtonLink
          to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}
          variant="secondary"
          size="sm"
        >
          Sign in
        </ButtonLink>
      </Panel>
    );
  }
  if (!isStudent) return null;
  if (mine.isPending) return <Skeleton className="h-24 w-full" />;
  if (mine.error) {
    return (
      <ErrorState
        title="Couldn’t check your review"
        error={mine.error}
        onRetry={() => void mine.refetch()}
        retrying={mine.isFetching}
      />
    );
  }

  const { eligible, review } = mine.data;
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <h2 id="your-review-heading" className="text-lg font-bold">
        Your review
      </h2>
      {review ? (
        <>
          {review.status === 'HIDDEN' && (
            <p className="rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700">
              The outlet hid this review from other students
              {review.moderationReason ? `: “${review.moderationReason}”` : '.'} It doesn’t count
              towards the rating.
            </p>
          )}
          <ReviewCard
            review={review}
            actions={
              <div className="flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PencilLine className="size-3.5" aria-hidden />}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="size-3.5" aria-hidden />}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              </div>
            }
          />
        </>
      ) : eligible ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-espresso-700">You’ve had this — how was it?</p>
          <Button onClick={() => setEditing(true)}>Rate food</Button>
        </div>
      ) : (
        <p className="text-espresso-700">
          You can rate this dish after you’ve collected an order with it.
        </p>
      )}
      {editing && (
        <ReviewFormDialog
          open
          onClose={() => setEditing(false)}
          itemId={itemId}
          itemName={itemName}
          existing={review}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete your review?"
        description="Your rating will no longer count for this dish. You can write a new one later."
        confirmLabel="Delete review"
        destructive
        loading={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          review &&
          remove.mutate(review.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast.show({ tone: 'success', title: 'Review deleted' });
            },
            onError: (e) =>
              toast.show({
                tone: 'error',
                title: 'Couldn’t delete',
                description: describeError(e),
              }),
          })
        }
      />
    </Panel>
  );
}
