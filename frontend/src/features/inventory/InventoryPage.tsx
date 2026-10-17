import { useMemo, useState } from 'react';
import { History, Minus, PackageSearch, Plus, Settings2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SearchField } from '@/components/ui/SearchField';
import { SelectField } from '@/components/ui/SelectField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { describeError } from '@/lib/errors';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/cn';
import { ApiError } from '@/services/http';
import { useInventory, type InventoryItem } from '@/services/inventory';
import { useSetAvailability, type StaffOutlet, type StaffRole } from '@/services/staff';
import type { StockStatus } from '@/services/outlets';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { DishThumb } from '@/features/specials/DishThumb';
import { StockBadge } from './StockBadge';
import { AdjustDialog, HistoryDialog, SettingsDialog } from './StockDialogs';

type Open =
  | { kind: 'RESTOCK' | 'REMOVAL' | 'SETTINGS' | 'HISTORY'; item: InventoryItem }
  | { kind: 'SOLD_OUT' | 'AVAILABLE'; item: InventoryItem }
  | null;

const FILTERS: { status: StockStatus | undefined; label: string }[] = [
  { status: undefined, label: 'All' },
  { status: 'LOW_STOCK', label: 'Low stock' },
  { status: 'SOLD_OUT', label: 'Sold out' },
  { status: 'AVAILABLE', label: 'In stock' },
];

function StockRow({
  item,
  canManage,
  busy,
  onOpen,
}: {
  item: InventoryItem;
  canManage: boolean;
  busy: boolean;
  onOpen: (open: Open) => void;
}) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 border-b border-dashed border-espresso-100 p-4 last:border-b-0 sm:flex-row sm:items-center',
        item.stockStatus === 'SOLD_OUT' && 'bg-cream-200/60',
        item.stockStatus === 'LOW_STOCK' && 'bg-mustard-50/60',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <DishThumb imageUrl={item.imageUrl} className="size-12" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{item.name}</p>
          <p className="truncate text-sm text-espresso-500">{item.category.name}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:w-64">
        <StockBadge status={item.stockStatus} audience="staff" />
        <span className="tabular">
          {item.trackInventory ? (
            <>
              <strong>{item.stockQuantity}</strong> left
              <span className="text-espresso-500"> · low at ≤ {item.lowStockThreshold}</span>
            </>
          ) : (
            <span className="text-espresso-500">Not counted</span>
          )}
        </span>
        {item.soldOutManually && (
          <span className="text-xs text-chili-600">Marked sold out by staff</span>
        )}
        {item.stockUpdatedAt && (
          <span className="text-xs text-espresso-500">Updated {timeAgo(item.stockUpdatedAt)}</span>
        )}
      </div>
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={`Stock actions for ${item.name}`}
      >
        {item.trackInventory && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onOpen({ kind: 'RESTOCK', item })}
              icon={<Plus className="size-4" aria-hidden />}
              aria-label={`Restock ${item.name}`}
            >
              Restock
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || (item.stockQuantity ?? 0) === 0}
              onClick={() => onOpen({ kind: 'REMOVAL', item })}
              icon={<Minus className="size-4" aria-hidden />}
              aria-label={`Remove stock of ${item.name}`}
            >
              Remove
            </Button>
          </>
        )}
        {item.soldOutManually ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onOpen({ kind: 'AVAILABLE', item })}
          >
            Make available
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpen({ kind: 'SOLD_OUT', item })}
          >
            Mark sold out
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpen({ kind: 'SETTINGS', item })}
            aria-label={`Stock settings for ${item.name}`}
            icon={<Settings2 className="size-4" aria-hidden />}
          >
            Settings
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpen({ kind: 'HISTORY', item })}
          aria-label={`Stock history for ${item.name}`}
          icon={<History className="size-4" aria-hidden />}
        />
      </div>
    </li>
  );
}

function Inventory({
  current,
  outlets,
  select,
  role,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
  role: StaffRole;
}) {
  const outletId = current.outlet.id;
  const canManage = current.roles.includes('MANAGER');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const [status, setStatus] = useState<StockStatus | undefined>(undefined);
  const [categoryId, setCategoryId] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const inventory = useInventory(outletId, {
    q: q || undefined,
    status,
    categoryId: categoryId || undefined,
  });
  const all = useInventory(outletId, {}); // categories and totals for the filter controls
  const availability = useSetAvailability(outletId);

  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of all.data?.items ?? []) seen.set(item.category.id, item.category.name);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [all.data]);

  const done = (_item: InventoryItem, message: string) => {
    setOpen(null);
    toast.show({ tone: 'success', title: 'Stock updated', description: message });
  };
  const failed = (error: unknown) =>
    toast.show({
      tone: 'error',
      title:
        error instanceof ApiError && error.status === 403 ? 'Not allowed' : 'Couldn’t update stock',
      description: describeError(error),
    });

  const counts = all.data?.counts;
  const items = inventory.data?.items ?? [];

  return (
    <>
      <PageHeader
        eyebrow={role === 'MANAGER' ? 'Kitchen' : 'Counter'}
        title="Stock"
        description={
          canManage
            ? 'Count units, set low-stock alerts, restock and mark items sold out. Students see changes straight away.'
            : 'Restock, remove units and mark items sold out or available. A manager sets up counting and alerts.'
        }
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />

      {counts && counts.LOW_STOCK + counts.SOLD_OUT > 0 && (
        <p
          role="status"
          className="mb-4 rounded-(--radius-control) bg-mustard-50 px-4 py-3 text-sm text-mustard-800"
        >
          {counts.LOW_STOCK > 0 && `${counts.LOW_STOCK} running low`}
          {counts.LOW_STOCK > 0 && counts.SOLD_OUT > 0 && ' · '}
          {counts.SOLD_OUT > 0 && `${counts.SOLD_OUT} sold out`}
        </p>
      )}

      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end">
        <SearchField
          label="Search items"
          placeholder="Search by name"
          value={search}
          onChange={setSearch}
          className="md:max-w-xs md:flex-1"
        />
        <SelectField
          label="Category"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="md:w-56"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Stock status filter">
          {FILTERS.map((f) => {
            const n = f.status
              ? counts?.[f.status]
              : counts && counts.AVAILABLE + counts.LOW_STOCK + counts.SOLD_OUT;
            const selected = status === f.status;
            return (
              <button
                key={f.label}
                type="button"
                aria-pressed={selected}
                onClick={() => setStatus(f.status)}
                className={cn(
                  'h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors',
                  selected
                    ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                    : 'border-espresso-200 bg-cream-50 hover:border-espresso-400',
                )}
              >
                {f.label}
                {n !== undefined && ` (${n})`}
              </button>
            );
          })}
        </div>
      </div>

      {inventory.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : inventory.error ? (
        <ErrorState
          title="Couldn’t load stock"
          error={inventory.error}
          onRetry={() => void inventory.refetch()}
          retrying={inventory.isFetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<PackageSearch aria-hidden />}
          title={q || status || categoryId ? 'No items match' : 'No menu items yet'}
          description={
            q || status || categoryId
              ? 'Try another search or filter.'
              : 'Items added on the Menu page will appear here.'
          }
        />
      ) : (
        <Panel className={cn(inventory.isFetching && 'opacity-80')}>
          <ul aria-label="Stock">
            {items.map((item) => (
              <StockRow
                key={item.id}
                item={item}
                canManage={canManage}
                busy={availability.isPending && availability.variables?.itemId === item.id}
                onOpen={setOpen}
              />
            ))}
          </ul>
        </Panel>
      )}

      {(open?.kind === 'RESTOCK' || open?.kind === 'REMOVAL') && (
        <AdjustDialog
          key={`${open.kind}-${open.item.id}`}
          outletId={outletId}
          item={open.item}
          mode={open.kind}
          onDone={done}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'SETTINGS' && (
        <SettingsDialog
          key={open.item.id}
          outletId={outletId}
          item={open.item}
          onDone={done}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'HISTORY' && (
        <HistoryDialog outletId={outletId} item={open.item} onClose={() => setOpen(null)} />
      )}
      <ConfirmDialog
        open={open?.kind === 'SOLD_OUT' || open?.kind === 'AVAILABLE'}
        title={
          open?.kind === 'SOLD_OUT'
            ? `Mark ${open.item.name} sold out?`
            : `Make ${open?.item.name} available?`
        }
        description={
          open?.kind === 'SOLD_OUT'
            ? 'Students can’t order it until staff make it available again — restocking alone won’t.'
            : open?.item.trackInventory && (open.item.stockQuantity ?? 0) === 0
              ? 'It has 0 in stock, so it stays sold out until it is restocked.'
              : 'Students will be able to order it again.'
        }
        confirmLabel={open?.kind === 'SOLD_OUT' ? 'Mark sold out' : 'Make available'}
        destructive={open?.kind === 'SOLD_OUT'}
        loading={availability.isPending}
        onConfirm={() => {
          if (!open || (open.kind !== 'SOLD_OUT' && open.kind !== 'AVAILABLE')) return;
          const { item, kind } = open;
          availability.mutate(
            { itemId: item.id, isAvailable: kind === 'AVAILABLE' },
            {
              onSuccess: () => {
                setOpen(null);
                toast.show({
                  tone: 'success',
                  title:
                    kind === 'SOLD_OUT' ? `${item.name} is sold out` : `${item.name} is available`,
                });
              },
              onError: (error) => {
                setOpen(null);
                failed(error);
              },
            },
          );
        }}
        onCancel={() => setOpen(null)}
      />
    </>
  );
}

export function ManagerInventoryPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <Inventory key={ctx.current.outlet.id} {...ctx} role="MANAGER" />}
    </StaffGate>
  );
}

export function PosStockPage() {
  return (
    <StaffGate role="POS">
      {(ctx) => <Inventory key={ctx.current.outlet.id} {...ctx} role="POS" />}
    </StaffGate>
  );
}
