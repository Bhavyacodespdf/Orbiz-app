import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Bookmark,
  History,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { useCurrentUser } from '@/services/auth';
import {
  useDeleteSavedCombo,
  useFavoriteCombos,
  useReorderHistory,
  useSavedCombos,
  type PreviewRequest,
  type ReorderLine,
  type ReorderSource,
} from '@/services/reorder';
import { DishThumb } from '@/features/specials/DishThumb';
import { CustomizeDialog } from './CustomizeDialog';
import { useReorderFlow } from './useReorderFlow';
import { availabilitySummary, formatOrderDate } from './reorder-labels';

type Evaluated = {
  outlet: { name: string; slug: string; acceptingOrders: boolean } | null;
  lines: ReorderLine[];
  addableCount: number;
  currentTotalPaise: number;
};

type CustomizeTarget = {
  title: string;
  outletSlug: string;
  items: { menuItemId: string; quantity: number }[];
  source: ReorderSource;
  saved?: { id: string; name: string };
};

/** A reorderable meal: dishes with images, outlet, availability, totals and the two actions. */
function MealCard({
  title,
  badge,
  meta,
  detail,
  meal,
  previousTotalPaise,
  reorderLabel,
  busy,
  onReorder,
  onCustomize,
  extraAction,
}: {
  title: string;
  badge?: { label: string; tone: BadgeTone; icon?: ReactNode };
  meta: string;
  detail?: string | null;
  meal: Evaluated;
  previousTotalPaise?: number;
  reorderLabel: string;
  busy: boolean;
  onReorder: () => void;
  onCustomize: () => void;
  extraAction?: ReactNode;
}) {
  const accepting = meal.outlet?.acceptingOrders ?? false;
  const summary = availabilitySummary(meal.lines, accepting);
  const allGood = summary === 'Available now';
  const changed = previousTotalPaise !== undefined && previousTotalPaise !== meal.currentTotalPaise;
  return (
    <article className="flex h-full flex-col gap-3 rounded-(--radius-panel) border border-espresso-100 bg-cream-50 p-4 shadow-press">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-bold">{title}</h3>
          <p className="text-sm text-espresso-500">{meta}</p>
        </div>
        {badge && (
          <Badge tone={badge.tone} icon={badge.icon}>
            {badge.label}
          </Badge>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {meal.lines.map((l) => (
          <li key={l.menuItemId} className="flex items-center gap-2 text-sm">
            <DishThumb imageUrl={l.imageUrl} className="size-8" />
            <span className={l.addableQuantity === 0 ? 'text-espresso-500 line-through' : ''}>
              {l.name} × {l.requestedQuantity}
            </span>
            {l.addableQuantity === 0 && <span className="sr-only">(unavailable)</span>}
          </li>
        ))}
      </ul>
      {detail && <p className="text-xs text-espresso-700">{detail}</p>}
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Badge
            tone={allGood ? 'success' : accepting && meal.addableCount > 0 ? 'mustard' : 'chili'}
          >
            {summary}
          </Badge>
          <span className="tabular">
            {changed && (
              <span className="mr-1 text-espresso-500">
                <span className="sr-only">Last time </span>
                <s>{formatINR(previousTotalPaise)}</s>
              </span>
            )}
            <span className="font-semibold">
              {changed && <span className="sr-only">now </span>}
              {formatINR(meal.currentTotalPaise)}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={onReorder}
            loading={busy}
            disabled={!accepting || meal.addableCount === 0}
            icon={<RotateCcw className="size-3.5" aria-hidden />}
            aria-label={reorderLabel}
          >
            Reorder
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onCustomize}
            icon={<SlidersHorizontal className="size-3.5" aria-hidden />}
            aria-label={`Customize ${title}`}
          >
            Customize
          </Button>
          {extraAction}
        </div>
      </div>
    </article>
  );
}

const itemsOf = (lines: ReorderLine[]) =>
  lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.requestedQuantity }));

/**
 * Quick Reorder + favourite combos on the student home page. Only for signed-in students; every
 * card comes from their own collected orders or saved combos (or clearly-labelled campus data).
 */
export function ReorderSections() {
  const { data: user } = useCurrentUser();
  const isStudent = Boolean(user?.roles.includes('STUDENT'));
  const history = useReorderHistory(isStudent);
  const combos = useFavoriteCombos(isStudent);
  const saved = useSavedCombos(isStudent);
  const remove = useDeleteSavedCombo();
  const toast = useToast();
  const flow = useReorderFlow();
  const [customize, setCustomize] = useState<CustomizeTarget | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  if (!isStudent) return null;

  const reorder = (key: string, request: PreviewRequest, source: ReorderSource, title: string) => {
    setBusyKey(key);
    flow.start(request, source, title);
  };
  const busy = (key: string) => flow.busy && busyKey === key;

  const historyCards = history.data?.orders ?? [];
  const savedCombos = saved.data ?? [];
  const suggested = combos.data?.combos ?? [];
  const popular = combos.data?.popular ?? [];
  const loading = history.isPending || combos.isPending || saved.isPending;

  return (
    <div className="mb-8 flex flex-col gap-8">
      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : history.error ? (
        <ErrorState
          title="Couldn’t load your recent orders"
          error={history.error}
          onRetry={() => void history.refetch()}
          retrying={history.isFetching}
        />
      ) : (
        historyCards.length > 0 && (
          <section aria-labelledby="quick-reorder-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="quick-reorder-heading" className="flex items-center gap-2 text-xl font-bold">
                <History className="size-5 text-chili-600" aria-hidden />
                Quick reorder
              </h2>
              <Link
                to="/orders?view=past"
                className="text-sm font-semibold text-chili-600 hover:underline"
              >
                Older orders
              </Link>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {historyCards.map((card) => (
                <li key={card.orderId}>
                  <MealCard
                    title={card.label}
                    meta={`${formatOrderDate(card.placedAt)} · ${card.outlet?.name ?? ''}`}
                    detail={
                      card.timesOrdered > 1
                        ? `Ordered ${card.timesOrdered} times in the last ${history.data!.windowDays} days`
                        : null
                    }
                    meal={card}
                    previousTotalPaise={card.previousTotalPaise}
                    reorderLabel={`Reorder ${card.label.toLowerCase()} from ${card.outlet?.name}`}
                    busy={busy(card.orderId)}
                    onReorder={() =>
                      reorder(
                        card.orderId,
                        { orderId: card.orderId },
                        { type: 'ORDER', orderId: card.orderId },
                        `Reorder ${card.label.toLowerCase()}`,
                      )
                    }
                    onCustomize={() =>
                      setCustomize({
                        title: card.label,
                        outletSlug: card.outlet!.slug,
                        items: itemsOf(card.lines),
                        source: { type: 'ORDER', orderId: card.orderId },
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      )}

      {!loading && !combos.error && (
        <section aria-labelledby="favorite-combos-heading" className="flex flex-col gap-3">
          <h2 id="favorite-combos-heading" className="flex items-center gap-2 text-xl font-bold">
            <Sparkles className="size-5 text-chili-600" aria-hidden />
            Your favourite combos
          </h2>
          {savedCombos.length === 0 && suggested.length === 0 ? (
            <p className="text-espresso-700">
              {historyCards.length === 0
                ? 'Once you’ve collected a few orders, the dishes you order together will show up here.'
                : 'Order the same dishes again and your usual combos will show up here.'}{' '}
              You can also save a combo from any card’s Customize.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {savedCombos.map((c) => (
                <li key={c.id}>
                  <MealCard
                    title={c.name}
                    badge={{
                      label: 'Saved',
                      tone: 'dark',
                      icon: <Bookmark className="size-3" aria-hidden />,
                    }}
                    meta={c.outlet?.name ?? ''}
                    meal={c}
                    reorderLabel={`Reorder ${c.name}`}
                    busy={busy(c.id)}
                    onReorder={() =>
                      reorder(
                        c.id,
                        { savedComboId: c.id },
                        { type: 'SAVED_COMBO', savedComboId: c.id },
                        `Reorder ${c.name}`,
                      )
                    }
                    onCustomize={() =>
                      setCustomize({
                        title: c.name,
                        outletSlug: c.outlet!.slug,
                        items: itemsOf(c.lines),
                        source: { type: 'SAVED_COMBO', savedComboId: c.id },
                        saved: { id: c.id, name: c.name },
                      })
                    }
                    extraAction={
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => setDeleting({ id: c.id, name: c.name })}
                        aria-label={`Delete saved combo ${c.name}`}
                      >
                        Delete
                      </Button>
                    }
                  />
                </li>
              ))}
              {suggested.map((c) => (
                <li key={c.key}>
                  <MealCard
                    title={c.name}
                    meta={c.outlet?.name ?? ''}
                    detail={[c.explanation, c.pattern].filter(Boolean).join(' · ')}
                    meal={c}
                    reorderLabel={`Reorder ${c.name}`}
                    busy={busy(c.key)}
                    onReorder={() =>
                      reorder(
                        c.key,
                        { items: itemsOf(c.lines) },
                        { type: 'SUGGESTED_COMBO' },
                        `Reorder ${c.name}`,
                      )
                    }
                    onCustomize={() =>
                      setCustomize({
                        title: c.name,
                        outletSlug: c.outlet!.slug,
                        items: itemsOf(c.lines),
                        source: { type: 'SUGGESTED_COMBO' },
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {popular.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 font-bold">
                <TrendingUp className="size-4 text-espresso-700" aria-hidden />
                Popular on campus
              </h3>
              <p className="text-sm text-espresso-500">
                Not personalised — counted from orders students collected in the last 30 days.
              </p>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {popular.map((p) => (
                  <li key={p.key}>
                    <MealCard
                      title={p.name}
                      meta={p.outlet?.name ?? ''}
                      detail={p.explanation}
                      meal={p}
                      reorderLabel={`Reorder ${p.name}`}
                      busy={busy(p.key)}
                      onReorder={() =>
                        reorder(
                          p.key,
                          { items: itemsOf(p.lines) },
                          { type: 'POPULAR' },
                          `Add ${p.name}`,
                        )
                      }
                      onCustomize={() =>
                        setCustomize({
                          title: p.name,
                          outletSlug: p.outlet!.slug,
                          items: itemsOf(p.lines),
                          source: { type: 'POPULAR' },
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {customize && (
        <CustomizeDialog
          title={customize.title}
          outletSlug={customize.outletSlug}
          initialItems={customize.items}
          source={customize.source}
          saved={customize.saved}
          flow={flow}
          onClose={() => setCustomize(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this saved combo?"
        description={`“${deleting?.name}” will be removed. Your order history isn’t affected.`}
        confirmLabel="Delete combo"
        destructive
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.show({ tone: 'success', title: 'Saved combo deleted' });
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
      {flow.dialogs}
    </div>
  );
}
