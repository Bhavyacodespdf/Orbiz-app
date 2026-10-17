import { useState } from 'react';
import {
  EyeOff,
  Flag,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import type { StaffOutlet } from '@/services/staff';
import {
  REPORT_REASONS,
  useModerateReview,
  useOutletReviewSummary,
  useOutletReviews,
  type ModerationAction,
  type OutletReviewFilter,
  type StaffReview,
  type Trend,
} from '@/services/reviews';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { RatingBreakdown, ReviewCard } from '@/features/reviews/ReviewSection';
import { formatAverage, ratingsLabel } from '@/features/reviews/review-labels';

const TREND: Record<Trend, { label: string; tone: BadgeTone }> = {
  IMPROVING: { label: 'Improving', tone: 'success' },
  DECLINING: { label: 'Declining', tone: 'chili' },
  STEADY: { label: 'Steady', tone: 'neutral' },
  NOT_ENOUGH_DATA: { label: 'Not enough recent reviews', tone: 'neutral' },
};

const reasonLabel = (value: string) =>
  REPORT_REASONS.find((r) => r.value === value)?.label ?? value;

const FILTERS: { value: OutletReviewFilter; label: string }[] = [
  { value: 'reported', label: 'Reported' },
  { value: 'hidden', label: 'Hidden' },
  { value: 'all', label: 'All reviews' },
];

function Summary({ outletId }: { outletId: string }) {
  const summary = useOutletReviewSummary(outletId);
  if (summary.isPending) return <Skeleton className="h-48 w-full" />;
  if (summary.error) {
    return (
      <ErrorState
        title="Couldn’t load the rating summary"
        error={summary.error}
        onRetry={() => void summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }
  const s = summary.data;
  if (s.total === 0) {
    return (
      <EmptyState
        icon={<MessageSquareText aria-hidden />}
        title="No reviews yet"
        description="Students who collect an order can rate each dish. Their ratings will show up here."
      />
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel className="flex flex-col gap-4 p-5">
        <h2 className="text-lg font-bold">Outlet rating</h2>
        <RatingBreakdown
          rating={{ average: s.average, count: s.total, distribution: s.distribution }}
        />
        {s.openReports > 0 && (
          <p className="flex items-center gap-2 text-sm font-semibold text-chili-700">
            <Flag className="size-4" aria-hidden />
            {s.openReports} reported {s.openReports === 1 ? 'review needs' : 'reviews need'} a look
          </p>
        )}
      </Panel>
      <Panel className="flex flex-col gap-3 p-5">
        <h2 className="text-lg font-bold">Dishes</h2>
        <p className="text-sm text-espresso-500">
          Trend compares the last {s.trendWindowDays} days with the {s.trendWindowDays} days before.
        </p>
        <ul className="flex flex-col divide-y divide-dashed divide-espresso-100">
          {s.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-semibold">{item.name}</span>
                <span className="block text-sm text-espresso-500">
                  ★ {formatAverage(item.average)} · {ratingsLabel(item.count)}
                  {item.recentAverage !== null && item.priorAverage !== null && (
                    <>
                      {' '}
                      · {formatAverage(item.priorAverage)} → {formatAverage(item.recentAverage)}
                    </>
                  )}
                </span>
              </span>
              <Badge
                tone={TREND[item.trend].tone}
                icon={
                  item.trend === 'IMPROVING' ? (
                    <TrendingUp className="size-3.5" aria-hidden />
                  ) : item.trend === 'DECLINING' ? (
                    <TrendingDown className="size-3.5" aria-hidden />
                  ) : undefined
                }
              >
                {TREND[item.trend].label}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>
      {s.recentFeedback.length > 0 && (
        <Panel className="flex flex-col p-5 lg:col-span-2">
          <h2 className="text-lg font-bold">Recent feedback</h2>
          {s.recentFeedback.map((r) => (
            <div key={r.id}>
              <p className="pt-3 text-sm font-semibold text-espresso-700">{r.item.name}</p>
              <ReviewCard review={r} />
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

function Moderation({ outletId }: { outletId: string }) {
  const [filter, setFilter] = useState<OutletReviewFilter>('reported');
  const reviews = useOutletReviews(outletId, filter);
  const moderate = useModerateReview(outletId);
  const toast = useToast();
  const [hiding, setHiding] = useState<StaffReview | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const all = reviews.data?.pages.flatMap((p) => p.reviews) ?? [];

  function act(review: StaffReview, action: ModerationAction, why?: string) {
    moderate.mutate(
      { reviewId: review.id, action, reason: why },
      {
        onSuccess: () => {
          setHiding(null);
          toast.show({
            tone: 'success',
            title:
              action === 'hide'
                ? 'Review hidden'
                : action === 'restore'
                  ? 'Review restored'
                  : 'Kept — reports closed',
          });
        },
        onError: (e) =>
          toast.show({ tone: 'error', title: 'That didn’t work', description: describeError(e) }),
      },
    );
  }

  return (
    <section aria-labelledby="moderation-heading" className="flex flex-col gap-3">
      <h2 id="moderation-heading" className="text-xl font-bold">
        Moderation
      </h2>
      <p className="text-sm text-espresso-500">
        Hide reviews that break the rules (abuse, spam, personal details) — not ones that are just
        negative. Hidden reviews don’t count towards ratings. You can’t edit what students wrote.
      </p>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors',
              filter === f.value
                ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                : 'border-espresso-200 bg-cream-50 text-espresso-700 hover:border-espresso-400',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {reviews.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : reviews.error ? (
        <ErrorState
          error={reviews.error}
          onRetry={() => void reviews.refetch()}
          retrying={reviews.isFetching}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck aria-hidden />}
          title={
            filter === 'reported'
              ? 'Nothing reported'
              : filter === 'hidden'
                ? 'No hidden reviews'
                : 'No reviews yet'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {all.map((r) => (
            <li key={r.id}>
              <Panel className="px-4 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.item.name}</span>
                  {r.status === 'HIDDEN' && <Badge tone="chili">Hidden</Badge>}
                  {r.openReports > 0 && (
                    <Badge tone="mustard" icon={<Flag className="size-3" aria-hidden />}>
                      {r.openReports} {r.openReports === 1 ? 'report' : 'reports'}:{' '}
                      {r.reportReasons.map(reasonLabel).join(', ')}
                    </Badge>
                  )}
                </div>
                {r.status === 'HIDDEN' && r.moderationReason && (
                  <p className="mt-1 text-sm text-espresso-700">
                    Hidden because: {r.moderationReason}
                  </p>
                )}
                <ReviewCard
                  review={r}
                  actions={
                    <div className="flex flex-wrap gap-1">
                      {r.status === 'PUBLISHED' ? (
                        <>
                          {r.openReports > 0 && (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<ShieldCheck className="size-3.5" aria-hidden />}
                              disabled={moderate.isPending}
                              onClick={() => act(r, 'keep')}
                            >
                              Keep
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<EyeOff className="size-3.5" aria-hidden />}
                            onClick={() => {
                              setReason('');
                              setReasonError(undefined);
                              setHiding(r);
                            }}
                          >
                            Hide
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<RotateCcw className="size-3.5" aria-hidden />}
                          disabled={moderate.isPending}
                          onClick={() => act(r, 'restore')}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  }
                />
              </Panel>
            </li>
          ))}
        </ul>
      )}
      {reviews.hasNextPage && (
        <Button
          variant="secondary"
          className="self-center"
          loading={reviews.isFetchingNextPage}
          onClick={() => void reviews.fetchNextPage()}
        >
          Show more
        </Button>
      )}
      <Dialog
        open={hiding !== null}
        onClose={() => setHiding(null)}
        title="Hide this review?"
        description="Other students won’t see it and it won’t count towards the rating. The student sees your reason."
        footer={
          <>
            <Button variant="secondary" onClick={() => setHiding(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={moderate.isPending}
              onClick={() => {
                if (!reason.trim()) {
                  setReasonError('Say why the review is being hidden.');
                  return;
                }
                if (hiding) act(hiding, 'hide', reason.trim());
              }}
            >
              Hide review
            </Button>
          </>
        }
      >
        <TextField
          label="Reason"
          value={reason}
          maxLength={300}
          onChange={(e) => {
            setReason(e.target.value);
            setReasonError(undefined);
          }}
          error={reasonError}
          data-autofocus
        />
      </Dialog>
    </section>
  );
}

function ReviewsManager({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const outletId = current.outlet.id;
  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Reviews"
        description="What students say about your dishes, from verified orders."
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />
      <div className="flex flex-col gap-8">
        <Summary outletId={outletId} />
        <Moderation outletId={outletId} />
      </div>
    </>
  );
}

export function ManagerReviewsPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <ReviewsManager key={ctx.current.outlet.id} {...ctx} />}
    </StaffGate>
  );
}
