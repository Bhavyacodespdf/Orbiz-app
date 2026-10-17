import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, CircleCheck, ShoppingBag } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, ButtonLink } from '@/components/ui/Button';
import { formatINR } from '@/lib/money';
import type { ReorderLine, ReorderPreview } from '@/services/reorder';
import { itemPath } from '@/features/reviews/review-labels';
import { UNAVAILABLE_TEXT, limitedText } from './reorder-labels';

export type Added = { lines: ReorderLine[]; totalPaise: number; skipped: ReorderLine[] };

function PriceNote({ line }: { line: ReorderLine }) {
  if (!line.priceChanged || line.historicalUnitPricePaise === null) return null;
  return (
    <span className="block text-xs font-semibold text-mustard-800">
      Price changed: was {formatINR(line.historicalUnitPricePaise)}, now{' '}
      {formatINR(line.currentUnitPricePaise!)} each
    </span>
  );
}

/** The review step: what will be added, price changes, what can't be added and alternatives. */
export function ReviewDialog({
  preview,
  title,
  notice,
  busy,
  onAdd,
  onAddAlternative,
  onClose,
}: {
  preview: ReorderPreview;
  title: string;
  notice: string | null;
  busy: boolean;
  onAdd: () => void;
  onAddAlternative: (menuItemId: string) => void;
  onClose: () => void;
}) {
  const ok = preview.lines.filter((l) => l.addableQuantity > 0);
  const missing = preview.lines.filter((l) => l.addableQuantity === 0);
  const accepting = preview.outlet?.acceptingOrders ?? false;
  const dishes = ok.reduce((s, l) => s + l.addableQuantity, 0);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={preview.outlet ? `From ${preview.outlet.name}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel reorder
          </Button>
          {accepting && ok.length > 0 && (
            <Button
              onClick={onAdd}
              loading={busy}
              icon={<ShoppingBag className="size-4" aria-hidden />}
            >
              Add {dishes} {dishes === 1 ? 'dish' : 'dishes'} ·{' '}
              {formatINR(preview.currentTotalPaise)}
            </Button>
          )}
        </>
      }
    >
      {notice && (
        <p
          role="status"
          className="rounded-(--radius-control) bg-mustard-50 p-3 text-sm text-mustard-800"
        >
          {notice}
        </p>
      )}
      {!accepting && (
        <p className="flex items-start gap-2 rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {preview.outlet?.name ?? 'This outlet'} isn’t taking orders right now, so nothing can be
          added. Try again when it opens.
        </p>
      )}
      {ok.length > 0 && accepting && (
        <section aria-labelledby="reorder-ok">
          <h3 id="reorder-ok" className="text-sm font-bold">
            Will be added at today’s prices
          </h3>
          <ul className="mt-1 divide-y divide-dashed divide-espresso-100">
            {ok.map((l) => (
              <li
                key={l.menuItemId}
                className="flex items-start justify-between gap-3 py-2 text-sm"
              >
                <span>
                  {l.name} × {l.addableQuantity}
                  {l.status === 'LIMITED' && (
                    <span className="block text-xs font-semibold text-mustard-800">
                      {limitedText(l)}
                    </span>
                  )}
                  <PriceNote line={l} />
                </span>
                <span className="shrink-0 tabular">
                  {formatINR(l.currentUnitPricePaise! * l.addableQuantity)}
                </span>
              </li>
            ))}
          </ul>
          {preview.historicalTotalPaise !== null &&
            preview.historicalTotalPaise !== preview.currentTotalPaise && (
              <p className="mt-1 text-xs text-espresso-500">
                Last time: {formatINR(preview.historicalTotalPaise)} · Now:{' '}
                {formatINR(preview.currentTotalPaise)} for what can be added
              </p>
            )}
        </section>
      )}
      {missing.length > 0 && (
        <section aria-labelledby="reorder-missing" className="flex flex-col gap-2">
          <h3 id="reorder-missing" className="text-sm font-bold">
            Can’t be added
          </h3>
          <ul className="flex flex-col gap-3">
            {missing.map((l) => (
              <li
                key={l.menuItemId}
                className="rounded-(--radius-control) bg-cream-200 p-3 text-sm"
              >
                <p className="font-semibold">
                  {l.name} × {l.requestedQuantity}
                </p>
                <p className="text-espresso-700">
                  {UNAVAILABLE_TEXT[l.status as keyof typeof UNAVAILABLE_TEXT]}. It won’t be added.
                </p>
                {accepting && l.alternatives.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    <p className="text-xs text-espresso-500">Similar dishes here (your choice):</p>
                    <div className="flex flex-wrap gap-1.5">
                      {l.alternatives.map((a) => (
                        <Button
                          key={a.menuItemId}
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => onAddAlternative(a.menuItemId)}
                        >
                          Add {a.name} · {formatINR(a.pricePaise)}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {l.elsewhere.length > 0 && (
                  <p className="mt-2 text-xs text-espresso-700">
                    Available at{' '}
                    {l.elsewhere.map((e, i) => (
                      <span key={e.menuItemId}>
                        {i > 0 && ', '}
                        <Link
                          to={itemPath(e.outlet.slug, e.menuItemId)}
                          className="font-semibold underline"
                        >
                          {e.outlet.name} ({formatINR(e.pricePaise)})
                        </Link>
                      </span>
                    ))}
                    .
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}

export function AddedDialog({ added, onClose }: { added: Added; onClose: () => void }) {
  const changed = added.lines.filter((l) => l.priceChanged);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Added to your tray"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep browsing
          </Button>
          <ButtonLink to="/cart">
            Review tray <ArrowRight className="size-4" aria-hidden />
          </ButtonLink>
        </>
      }
    >
      <ul className="flex flex-col gap-1 text-sm">
        {added.lines.map((l) => (
          <li key={l.menuItemId} className="flex items-start gap-2">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-600" aria-hidden />
            <span>
              {l.name} × {l.addableQuantity}
              <PriceNote line={l} />
            </span>
          </li>
        ))}
      </ul>
      {added.skipped.length > 0 && (
        <p className="text-sm text-espresso-700">
          Not added: {added.skipped.map((l) => l.name).join(', ')}.
        </p>
      )}
      <p className="text-sm text-espresso-700">
        Tray total for these dishes: <strong>{formatINR(added.totalPaise)}</strong>
        {changed.length > 0 && ' at today’s prices'}. Nothing is charged until you check out.
      </p>
    </Dialog>
  );
}
