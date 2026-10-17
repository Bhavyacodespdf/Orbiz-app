import { useState } from 'react';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { describeError } from '@/lib/errors';
import { formatDateTime } from '@/lib/time';
import {
  useAdjustStock,
  useSetThreshold,
  useSetTracking,
  useStockHistory,
  type InventoryItem,
  type StockHistoryEntry,
} from '@/services/inventory';

const MAX_STOCK = 100_000;
const MAX_THRESHOLD = 10_000;

/** A whole number from a text field, or null if it isn't one in range. */
function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-chili-600">
      {describeError(error)}
    </p>
  );
}

/** Restock (add units) or remove units (waste, damage, correction — reason required). */
export function AdjustDialog({
  outletId,
  item,
  mode,
  onDone,
  onClose,
}: {
  outletId: string;
  item: InventoryItem;
  mode: 'RESTOCK' | 'REMOVAL';
  onDone: (item: InventoryItem, message: string) => void;
  onClose: () => void;
}) {
  const adjust = useAdjustStock(outletId);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [markAvailable, setMarkAvailable] = useState(item.soldOutManually);
  const [error, setError] = useState<string | null>(null);
  const restock = mode === 'RESTOCK';
  const current = item.stockQuantity ?? 0;

  function submit() {
    setError(null);
    const max = restock ? MAX_STOCK - current : current;
    const n = wholeNumber(quantity, 1, Math.max(max, 1));
    if (n === null || n > max) {
      setError(
        restock
          ? 'Enter how many units arrived (a whole number).'
          : `Enter a whole number from 1 to ${current}.`,
      );
      return;
    }
    if (!restock && reason.trim().length < 3) {
      setError('Say why the stock is being removed.');
      return;
    }
    adjust.mutate(
      restock
        ? {
            itemId: item.id,
            type: 'RESTOCK',
            quantity: n,
            reason: reason.trim() || undefined,
            markAvailable,
          }
        : { itemId: item.id, type: 'REMOVAL', quantity: n, reason: reason.trim() },
      {
        onSuccess: (updated) =>
          onDone(
            updated,
            restock
              ? `${item.name}: +${n} → ${updated.stockQuantity} in stock`
              : `${item.name}: −${n} → ${updated.stockQuantity} in stock`,
          ),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={restock ? `Restock ${item.name}` : `Remove stock: ${item.name}`}
      description={`${current} in stock now.`}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label={restock ? 'Units to add' : 'Units to remove'}
          inputMode="numeric"
          value={quantity}
          autoFocus
          onChange={(event) => setQuantity(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
        />
        <TextField
          label={restock ? 'Note (optional)' : 'Reason'}
          placeholder={restock ? 'e.g. Morning delivery' : 'e.g. Damaged, expired, miscount'}
          value={reason}
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
        />
        {restock && item.soldOutManually && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-chili-500"
              checked={markAvailable}
              onChange={(event) => setMarkAvailable(event.target.checked)}
            />
            <span>
              Also make it available again
              <span className="block text-espresso-500">
                It was marked sold out by staff. Restocking alone keeps it sold out.
              </span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-chili-600">
            {error}
          </p>
        )}
        <ErrorLine error={adjust.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant={restock ? 'primary' : 'danger'} loading={adjust.isPending}>
            {restock ? 'Add stock' : 'Remove stock'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Manager settings: start/stop counting units, the low-stock threshold, and replacing the
 * recorded quantity with a stock count.
 */
export function SettingsDialog({
  outletId,
  item,
  onDone,
  onClose,
}: {
  outletId: string;
  item: InventoryItem;
  onDone: (item: InventoryItem, message: string) => void;
  onClose: () => void;
}) {
  const tracking = useSetTracking(outletId);
  const threshold = useSetThreshold(outletId);
  const adjust = useAdjustStock(outletId);
  const [onHand, setOnHand] = useState('');
  const [limit, setLimit] = useState(String(item.lowStockThreshold || 5));
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const busy = tracking.isPending || threshold.isPending || adjust.isPending;
  const serverError = tracking.error ?? threshold.error ?? adjust.error;

  function startCounting() {
    setError(null);
    const quantity = wholeNumber(onHand, 0, MAX_STOCK);
    const lowStockThreshold = wholeNumber(limit, 0, MAX_THRESHOLD);
    if (quantity === null) return setError('Enter the number of units you have now (0 or more).');
    if (lowStockThreshold === null)
      return setError(`Enter a threshold from 0 to ${MAX_THRESHOLD}.`);
    tracking.mutate(
      { itemId: item.id, enabled: true, quantity, lowStockThreshold },
      { onSuccess: (updated) => onDone(updated, `${item.name}: now counting stock (${quantity})`) },
    );
  }

  function saveThreshold() {
    setError(null);
    const lowStockThreshold = wholeNumber(limit, 0, MAX_THRESHOLD);
    if (lowStockThreshold === null)
      return setError(`Enter a threshold from 0 to ${MAX_THRESHOLD}.`);
    threshold.mutate(
      { itemId: item.id, lowStockThreshold },
      {
        onSuccess: (updated) =>
          onDone(updated, `${item.name}: low stock at ${lowStockThreshold} or fewer`),
      },
    );
  }

  function saveCount() {
    setError(null);
    const quantity = wholeNumber(counted, 0, MAX_STOCK);
    if (quantity === null) return setError('Enter the counted number of units (0 or more).');
    adjust.mutate(
      {
        itemId: item.id,
        type: 'COUNT_SET',
        quantity,
        expectedQuantity: item.stockQuantity ?? 0,
        reason: 'Stock count',
      },
      { onSuccess: (updated) => onDone(updated, `${item.name}: count set to ${quantity}`) },
    );
  }

  return (
    <Dialog open onClose={onClose} title={`Stock settings: ${item.name}`}>
      <div className="flex flex-col gap-5">
        {!item.trackInventory ? (
          <section className="flex flex-col gap-3">
            <p className="text-sm text-espresso-700">
              This item isn’t counted yet, so it’s available until someone marks it sold out. Count
              what you have to start tracking units; orders will then take stock automatically.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Units on hand"
                inputMode="numeric"
                value={onHand}
                onChange={(event) =>
                  setOnHand(event.target.value.replace(/[^\d]/g, '').slice(0, 6))
                }
              />
              <TextField
                label="Low stock at or below"
                inputMode="numeric"
                value={limit}
                onChange={(event) => setLimit(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
              />
            </div>
            <Button onClick={startCounting} loading={tracking.isPending} disabled={busy}>
              Start counting stock
            </Button>
          </section>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <TextField
                  label="Low stock at or below"
                  inputMode="numeric"
                  value={limit}
                  onChange={(event) =>
                    setLimit(event.target.value.replace(/[^\d]/g, '').slice(0, 5))
                  }
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  onClick={saveThreshold}
                  loading={threshold.isPending}
                  disabled={busy}
                >
                  Save
                </Button>
              </div>
            </section>
            <section className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <TextField
                  label={`Stock count (recorded: ${item.stockQuantity ?? 0})`}
                  inputMode="numeric"
                  value={counted}
                  onChange={(event) =>
                    setCounted(event.target.value.replace(/[^\d]/g, '').slice(0, 6))
                  }
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  onClick={saveCount}
                  loading={adjust.isPending}
                  disabled={busy}
                >
                  Set count
                </Button>
              </div>
              <p className="text-xs text-espresso-500">
                Replaces the recorded quantity. If stock changes before you save, you’ll be asked to
                recount.
              </p>
            </section>
            <Button
              variant="ghost"
              onClick={() => setConfirmStop(true)}
              disabled={busy}
              className="w-fit"
            >
              Stop counting this item
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-chili-600">
            {error}
          </p>
        )}
        <ErrorLine error={serverError} />
      </div>
      <ConfirmDialog
        open={confirmStop}
        title="Stop counting this item?"
        description="Its quantity is cleared and orders stop taking stock. It stays available unless marked sold out."
        confirmLabel="Stop counting"
        destructive
        loading={tracking.isPending}
        onConfirm={() =>
          tracking.mutate(
            { itemId: item.id, enabled: false },
            {
              onSuccess: (updated) => {
                setConfirmStop(false);
                onDone(updated, `${item.name}: no longer counted`);
              },
              onError: () => setConfirmStop(false),
            },
          )
        }
        onCancel={() => setConfirmStop(false)}
      />
    </Dialog>
  );
}

const HISTORY_LABELS: Record<string, string> = {
  RESTOCK: 'Restocked',
  REMOVAL: 'Removed',
  COUNT_SET: 'Stock count',
  ORDER_DEDUCTION: 'Ordered',
  ORDER_RESTORE: 'Order cancelled — returned',
  TRACKING_ENABLED: 'Started counting',
  TRACKING_DISABLED: 'Stopped counting',
  THRESHOLD_CHANGED: 'Threshold changed',
  MARKED_SOLD_OUT: 'Marked sold out',
  MARKED_AVAILABLE: 'Marked available',
};

function HistoryRow({ entry }: { entry: StockHistoryEntry }) {
  const change = entry.quantityChange;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-dashed border-espresso-100 py-2 text-sm last:border-b-0">
      <div className="min-w-0">
        <p className="font-semibold">{HISTORY_LABELS[entry.type] ?? entry.type}</p>
        <p className="text-espresso-500">
          {formatDateTime(entry.createdAt)} ·{' '}
          {entry.actor
            ? `${entry.actor.displayName}${entry.actor.role ? ` (${entry.actor.role})` : ''}`
            : 'System'}
          {entry.reason && ` · ${entry.reason}`}
        </p>
      </div>
      <span className="tabular shrink-0 text-right">
        {change !== 0 && (
          <span className={change > 0 ? 'text-success-600' : 'text-chili-600'}>
            {change > 0 ? '+' : '−'}
            {Math.abs(change)}
          </span>
        )}
        {entry.resultingQuantity !== null && (
          <span className="block text-xs text-espresso-500">→ {entry.resultingQuantity}</span>
        )}
      </span>
    </li>
  );
}

export function HistoryDialog({
  outletId,
  item,
  onClose,
}: {
  outletId: string;
  item: InventoryItem;
  onClose: () => void;
}) {
  const history = useStockHistory(outletId, item.id);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Stock history: ${item.name}`}
      description="Latest 50 changes."
    >
      {history.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : history.error ? (
        <ErrorLine error={history.error} />
      ) : history.data.length === 0 ? (
        <p className="text-sm text-espresso-500">No changes recorded yet.</p>
      ) : (
        <ul aria-label="Stock changes" className="max-h-96 overflow-y-auto">
          {history.data.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
