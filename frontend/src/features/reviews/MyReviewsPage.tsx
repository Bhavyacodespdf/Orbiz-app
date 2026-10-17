import { useState } from 'react';
import { Link } from 'react-router';
import { MessageSquareText, PencilLine, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/feedback/Skeleton';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { useDeleteReview, useMyReviews, type MyReviewsPage as Page } from '@/services/reviews';
import { ReviewCard } from './ReviewSection';
import { ReviewFormDialog } from './ReviewFormDialog';
import { itemPath } from './review-labels';

type MyReview = Page['reviews'][number];

/** The student's own reviews: what they wrote, when, and whether it is visible. */
export function MyReviewsPage() {
  const reviews = useMyReviews();
  const remove = useDeleteReview();
  const toast = useToast();
  const [editing, setEditing] = useState<MyReview | null>(null);
  const [deleting, setDeleting] = useState<MyReview | null>(null);
  const all = reviews.data?.pages.flatMap((p) => p.reviews) ?? [];

  return (
    <>
      <PageHeader title="My reviews" description="Ratings you’ve given dishes you collected." />
      {reviews.isPending ? (
        <div aria-busy className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : reviews.error ? (
        <ErrorState
          title="Couldn’t load your reviews"
          error={reviews.error}
          onRetry={() => void reviews.refetch()}
          retrying={reviews.isFetching}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText aria-hidden />}
          title="No reviews yet"
          description="After you collect an order, you can rate each dish from the order page or the dish’s page."
          action={<ButtonLink to="/orders">See your orders</ButtonLink>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {all.map((r) => (
            <li
              key={r.id}
              className="rounded-(--radius-panel) border border-espresso-100 bg-cream-50 px-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
                <div className="min-w-0">
                  {r.item.isActive ? (
                    <Link
                      to={itemPath(r.outlet.slug, r.item.id)}
                      className="font-semibold hover:underline"
                    >
                      {r.item.name}
                    </Link>
                  ) : (
                    <span className="font-semibold">{r.item.name}</span>
                  )}
                  <span className="text-sm text-espresso-500"> · {r.outlet.name}</span>
                </div>
                {r.status === 'HIDDEN' ? (
                  <Badge tone="chili">Hidden by the outlet</Badge>
                ) : !r.item.isActive ? (
                  <Badge>No longer on the menu</Badge>
                ) : null}
              </div>
              {r.status === 'HIDDEN' && r.moderationReason && (
                <p className="mt-2 text-sm text-chili-700">Reason: “{r.moderationReason}”</p>
              )}
              <ReviewCard
                review={r}
                actions={
                  <div className="flex gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<PencilLine className="size-3.5" aria-hidden />}
                      onClick={() => setEditing(r)}
                      aria-label={`Edit your review of ${r.item.name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => setDeleting(r)}
                      aria-label={`Delete your review of ${r.item.name}`}
                    >
                      Delete
                    </Button>
                  </div>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {reviews.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-4 self-center"
          loading={reviews.isFetchingNextPage}
          onClick={() => void reviews.fetchNextPage()}
        >
          Show more
        </Button>
      )}
      {editing && (
        <ReviewFormDialog
          open
          onClose={() => setEditing(null)}
          itemId={editing.item.id}
          itemName={editing.item.name}
          existing={editing}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete your review?"
        description={deleting ? `Your rating of ${deleting.item.name} will no longer count.` : ''}
        confirmLabel="Delete review"
        destructive
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
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
    </>
  );
}
