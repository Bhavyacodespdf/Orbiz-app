import { useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { newIdempotencyKey } from '@/lib/idempotency';
import { ApiError } from '@/services/http';
import {
  usePreviewReorder,
  useReorderIntoCart,
  type PreviewRequest,
  type ReorderLine,
  type ReorderPreview,
  type ReorderSource,
} from '@/services/reorder';
import { AddedDialog, ReviewDialog, type Added } from './ReorderDialogs';

const addableItems = (lines: ReorderLine[]) =>
  lines
    .filter((l) => l.addableQuantity > 0)
    .map((l) => ({ menuItemId: l.menuItemId, quantity: l.addableQuantity }));

/**
 * One-tap reorder: previews on the server; if everything is exactly as before it goes straight
 * into the tray, otherwise the student reviews changes first. Never substitutes a dish silently,
 * never charges anything — checkout does that.
 */
export function useReorderFlow(): {
  start: (request: PreviewRequest, source: ReorderSource, title: string) => void;
  /** Adds an already-reviewed list (e.g. from Customize). */
  addReviewed: (preview: ReorderPreview, source: ReorderSource) => void;
  busy: boolean;
  dialogs: ReactNode;
} {
  const previewer = usePreviewReorder();
  const adder = useReorderIntoCart();
  const toast = useToast();
  const [review, setReview] = useState<{
    preview: ReorderPreview;
    source: ReorderSource;
    title: string;
    notice: string | null;
  } | null>(null);
  const [conflict, setConflict] = useState<{
    preview: ReorderPreview;
    source: ReorderSource;
    current: string;
  } | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const key = useRef(newIdempotencyKey());

  function fail(error: unknown) {
    toast.show({ tone: 'error', title: 'Couldn’t reorder', description: describeError(error) });
  }

  function add(preview: ReorderPreview, source: ReorderSource, title: string, replaceCart = false) {
    const items = addableItems(preview.lines);
    if (items.length === 0) return;
    adder.mutate(
      {
        items,
        expectedTotalPaise: preview.currentTotalPaise,
        replaceCart,
        source,
        idempotencyKey: key.current,
      },
      {
        onSuccess: () => {
          key.current = newIdempotencyKey();
          setReview(null);
          setConflict(null);
          setAdded({
            lines: preview.lines.filter((l) => l.addableQuantity > 0),
            skipped: preview.lines.filter((l) => l.addableQuantity === 0),
            totalPaise: preview.currentTotalPaise,
          });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'CART_OUTLET_CONFLICT') {
            const current =
              (error.details as { currentOutlet?: { name: string } } | undefined)?.currentOutlet
                ?.name ?? 'another outlet';
            setConflict({ preview, source, current });
            return;
          }
          setConflict(null);
          if (
            error instanceof ApiError &&
            [
              'PRICE_CHANGED',
              'ITEMS_UNAVAILABLE',
              'OUTLET_NOT_ACCEPTING',
              'INSUFFICIENT_STOCK',
            ].includes(error.code)
          ) {
            // Something changed since the preview: check again and show the student.
            previewer.mutate(
              {
                items: preview.lines.map((l) => ({
                  menuItemId: l.menuItemId,
                  quantity: l.requestedQuantity,
                })),
              },
              {
                onSuccess: (fresh) =>
                  setReview({
                    preview: { ...fresh, historicalTotalPaise: preview.historicalTotalPaise },
                    source,
                    title,
                    notice: `${error.message} Here’s what can be added now.`,
                  }),
                onError: fail,
              },
            );
            return;
          }
          fail(error);
        },
      },
    );
  }

  function start(request: PreviewRequest, source: ReorderSource, title: string) {
    if (previewer.isPending || adder.isPending) return;
    previewer.mutate(request, {
      onSuccess: (preview) => {
        if (preview.unchanged && preview.outlet?.acceptingOrders) add(preview, source, title);
        else setReview({ preview, source, title, notice: null });
      },
      onError: fail,
    });
  }

  function addAlternative(menuItemId: string) {
    if (!review) return;
    const items = [...addableItems(review.preview.lines), { menuItemId, quantity: 1 }];
    previewer.mutate(
      { items },
      {
        onSuccess: (fresh) =>
          setReview({
            ...review,
            preview: {
              ...fresh,
              // Keep the dishes that can't be added visible (they're still not added).
              lines: [
                ...fresh.lines,
                ...review.preview.lines.filter(
                  (l) =>
                    l.addableQuantity === 0 &&
                    !l.alternatives.some((a) => a.menuItemId === menuItemId),
                ),
              ],
              historicalTotalPaise: null,
            },
          }),
        onError: fail,
      },
    );
  }

  const dialogs = (
    <>
      {review && (
        <ReviewDialog
          preview={review.preview}
          title={review.title}
          notice={review.notice}
          busy={adder.isPending || previewer.isPending}
          onAdd={() => add(review.preview, review.source, review.title)}
          onAddAlternative={addAlternative}
          onClose={() => setReview(null)}
        />
      )}
      <ConfirmDialog
        open={conflict !== null}
        title="Start a new tray?"
        description={`Your tray has dishes from ${conflict?.current}. A tray holds one outlet at a time, so reordering will replace them.`}
        confirmLabel="Replace tray"
        cancelLabel="Keep my tray"
        loading={adder.isPending}
        onConfirm={() =>
          conflict && add(conflict.preview, conflict.source, review?.title ?? '', true)
        }
        onCancel={() => setConflict(null)}
      />
      {added && <AddedDialog added={added} onClose={() => setAdded(null)} />}
    </>
  );

  return {
    start,
    addReviewed: (preview, source) => add(preview, source, 'Reorder'),
    busy: previewer.isPending || adder.isPending,
    dialogs,
  };
}
