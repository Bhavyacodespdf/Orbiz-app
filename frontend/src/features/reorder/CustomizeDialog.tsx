import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { useOutletMenu } from '@/services/outlets';
import { useReorderQuote, useSaveCombo, type ReorderSource } from '@/services/reorder';
import { QuantityStepper } from '@/features/cart/QuantityStepper';
import { UNAVAILABLE_TEXT, limitedText } from './reorder-labels';
import type { useReorderFlow } from './useReorderFlow';

type Item = { menuItemId: string; quantity: number };

/**
 * Edit a combo before it goes in the tray: quantities, removals and extra dishes from the same
 * outlet. Prices, availability and the total come from the server on every change.
 */
export function CustomizeDialog({
  title,
  outletSlug,
  initialItems,
  source,
  saved,
  flow,
  onClose,
}: {
  title: string;
  outletSlug: string;
  initialItems: Item[];
  source: ReorderSource;
  /** Editing a saved combo: saving updates it. */
  saved?: { id: string; name: string };
  flow: ReturnType<typeof useReorderFlow>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [extra, setExtra] = useState('');
  const [comboName, setComboName] = useState(saved?.name ?? '');
  const [nameError, setNameError] = useState<string>();
  const quote = useReorderQuote(items);
  const menu = useOutletMenu(outletSlug, {});
  const save = useSaveCombo();

  const preview = quote.data;
  const lineFor = (id: string) => preview?.lines.find((l) => l.menuItemId === id);
  const extras =
    menu.data?.items.filter((i) => i.isAvailable && !items.some((x) => x.menuItemId === i.id)) ??
    [];
  const addable = preview?.lines.filter((l) => l.addableQuantity > 0) ?? [];
  const blocked = preview?.lines.filter((l) => l.addableQuantity === 0) ?? [];

  function setQuantity(menuItemId: string, quantity: number) {
    setItems((list) => list.map((i) => (i.menuItemId === menuItemId ? { ...i, quantity } : i)));
  }

  function saveCombo() {
    if (!comboName.trim()) {
      setNameError('Name your combo.');
      return;
    }
    save.mutate(
      { comboId: saved?.id ?? null, name: comboName.trim(), items },
      {
        onSuccess: () =>
          toast.show({ tone: 'success', title: saved ? 'Saved combo updated' : 'Combo saved' }),
        onError: (e) => setNameError(describeError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Customize: ${title}`}
      description={menu.data ? `From ${menu.data.outlet.name}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!preview || addable.length === 0 || quote.isFetching}
            loading={flow.busy}
            onClick={() => {
              if (!preview) return;
              flow.addReviewed(preview, source);
              onClose();
            }}
          >
            Add to tray{preview ? ` · ${formatINR(preview.currentTotalPaise)}` : ''}
          </Button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="text-espresso-700">No dishes left. Add one below or cancel.</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-dashed divide-espresso-100"
          aria-busy={quote.isFetching}
        >
          {items.map((item) => {
            const line = lineFor(item.menuItemId);
            return (
              <li
                key={item.menuItemId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{line?.name ?? '…'}</p>
                  {line && line.addableQuantity === 0 && (
                    <p className="text-xs font-semibold text-chili-700">
                      {UNAVAILABLE_TEXT[line.status as keyof typeof UNAVAILABLE_TEXT]} — won’t be
                      added
                    </p>
                  )}
                  {line?.status === 'LIMITED' && (
                    <p className="text-xs font-semibold text-mustard-800">{limitedText(line)}</p>
                  )}
                  {line?.currentUnitPricePaise != null && (
                    <p className="text-xs text-espresso-500">
                      {formatINR(line.currentUnitPricePaise)} each
                    </p>
                  )}
                </div>
                <QuantityStepper
                  name={line?.name ?? 'dish'}
                  quantity={item.quantity}
                  onChange={(q) => setQuantity(item.menuItemId, q)}
                  onRemove={() =>
                    setItems((list) => list.filter((i) => i.menuItemId !== item.menuItemId))
                  }
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <SelectField
          label="Add a dish from this outlet"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          className="flex-1"
          disabled={!menu.data}
        >
          <option value="">Choose a dish…</option>
          {extras.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} — {formatINR(i.pricePaise)}
            </option>
          ))}
        </SelectField>
        <Button
          variant="secondary"
          icon={<Plus className="size-4" aria-hidden />}
          disabled={!extra}
          onClick={() => {
            setItems((list) => [...list, { menuItemId: extra, quantity: 1 }]);
            setExtra('');
          }}
        >
          Add
        </Button>
      </div>

      <div className="flex items-center justify-between rounded-(--radius-control) bg-cream-200 px-3 py-2">
        <span className="text-sm font-semibold">Total at today’s prices</span>
        {preview ? (
          <span className="font-bold tabular" aria-live="polite">
            {formatINR(preview.currentTotalPaise)}
          </span>
        ) : (
          <Skeleton className="h-5 w-16" />
        )}
      </div>
      {blocked.length > 0 && (
        <p className="text-xs text-espresso-700">
          Not included: {blocked.map((l) => l.name).join(', ')}.
        </p>
      )}

      <div className="flex items-end gap-2 border-t border-dashed border-espresso-100 pt-3">
        <TextField
          label={saved ? 'Saved combo name' : 'Save for next time (optional)'}
          placeholder="e.g. Exam-night fuel"
          value={comboName}
          maxLength={60}
          onChange={(e) => {
            setComboName(e.target.value);
            setNameError(undefined);
          }}
          error={nameError}
          className="flex-1"
        />
        <Button
          variant="secondary"
          onClick={saveCombo}
          loading={save.isPending}
          disabled={items.length === 0}
        >
          {saved ? 'Update' : 'Save combo'}
        </Button>
      </div>
    </Dialog>
  );
}
