import { useState } from 'react';
import { Banknote, ChefHat, History, QrCode, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import type { OrderStatus } from '@/services/orders';
import {
  useStaffHistory,
  useStaffQueue,
  type QueueFilter,
  useTransitionOrder,
  type StaffOrderSummary,
  type StaffOutlet,
} from '@/services/staff';
import { statusLabels } from '@/features/orders/order-labels';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { OrderCard } from '@/features/staff/OrderCard';
import { OrderActionsDialog } from '@/features/staff/OrderActionsDialog';
import { PaymentBadge } from '@/features/staff/PaymentBadge';
import { actionLabels } from '@/features/staff/order-actions';
import { QueueFilterChips } from '@/features/staff/QueueFilter';
import { useNewOrderAlerts } from '@/features/staff/useNewOrderAlerts';
import { VerifyPickupDialog } from '@/features/pickup/VerifyPickupDialog';

const NEXT: Partial<Record<OrderStatus, OrderStatus>> = {
  PLACED: 'ACCEPTED',
  ACCEPTED: 'PREPARING',
  PREPARING: 'READY',
};

/** What the big button on a ticket does for POS staff. */
function primaryAction(
  order: StaffOrderSummary,
): { kind: 'pay' } | { kind: 'verify' } | { kind: 'move'; to: OrderStatus } | null {
  if (order.status === 'READY' && order.paymentStatus === 'PENDING_COUNTER') return { kind: 'pay' };
  // Handing over needs the student's pickup code: verify it, then confirm.
  if (order.status === 'READY') return { kind: 'verify' };
  const to = NEXT[order.status];
  return to ? { kind: 'move', to } : null;
}

function Queue({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const outletId = current.outlet.id;
  const [filter, setFilter] = useState<QueueFilter>('ALL');
  const queue = useStaffQueue(outletId, filter);
  const transition = useTransitionOrder(outletId);
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [verifying, setVerifying] = useState(false);
  useNewOrderAlerts(outletId);

  const needle = search.trim().toUpperCase().replace(/\s+/g, '');
  const orders = (queue.data ?? []).filter(
    (o) => !needle || o.pickupCode.replace('-', '').includes(needle.replace('-', '')),
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-extrabold">Active orders · {current.outlet.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => setVerifying(true)}
            icon={<QrCode className="size-4" aria-hidden />}
          >
            Verify pickup
          </Button>
          <OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />
        </div>
      </div>
      <QueueFilterChips value={filter} onChange={setFilter} />
      <SearchField
        label="Find by pickup code"
        placeholder="Pickup code, e.g. N-007"
        value={search}
        onChange={setSearch}
        className="max-w-sm"
      />

      {queue.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : queue.error ? (
        <ErrorState
          error={queue.error}
          onRetry={() => void queue.refetch()}
          retrying={queue.isFetching}
        />
      ) : orders.length === 0 ? (
        needle ? (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title={`No active order matches “${search.trim()}”`}
          />
        ) : (
          <EmptyState
            icon={<ChefHat aria-hidden />}
            title="No active orders"
            description="New orders appear here the moment they’re placed."
          />
        )
      ) : (
        <ul aria-label="Order queue" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orders.map((order) => {
            const action = primaryAction(order);
            const moving = transition.isPending && transition.variables?.orderId === order.id;
            return (
              <li key={order.id}>
                <OrderCard
                  large
                  order={order}
                  onOpen={() => setOpenId(order.id)}
                  action={
                    action?.kind === 'pay' ? (
                      <Button
                        size="lg"
                        onClick={() => setOpenId(order.id)}
                        icon={<Banknote className="size-5" aria-hidden />}
                      >
                        Take {formatINR(order.totalPaise)}
                      </Button>
                    ) : action?.kind === 'verify' ? (
                      <Button
                        size="lg"
                        variant="secondary"
                        onClick={() => setVerifying(true)}
                        icon={<QrCode className="size-5" aria-hidden />}
                      >
                        Verify pickup
                      </Button>
                    ) : action?.kind === 'move' ? (
                      <Button
                        size="lg"
                        loading={moving}
                        disabled={transition.isPending && !moving}
                        onClick={() =>
                          transition.mutate(
                            { orderId: order.id, to: action.to },
                            {
                              onSuccess: () =>
                                toast.show({
                                  tone: 'success',
                                  title: `${order.pickupCode}: ${statusLabels[action.to]}`,
                                }),
                              onError: (e) =>
                                toast.show({
                                  tone: 'error',
                                  title: `Couldn’t update ${order.pickupCode}`,
                                  description: describeError(e),
                                }),
                            },
                          )
                        }
                      >
                        {actionLabels[action.to]}
                      </Button>
                    ) : null
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <OrderActionsDialog
        outletId={outletId}
        orderId={openId}
        onClose={() => setOpenId(null)}
        onVerifyPickup={() => setVerifying(true)}
      />
      <VerifyPickupDialog
        open={verifying}
        outletId={outletId}
        outletName={current.outlet.name}
        onClose={() => setVerifying(false)}
      />
    </div>
  );
}

export function PosQueuePage() {
  return <StaffGate role="POS">{(ctx) => <Queue {...ctx} />}</StaffGate>;
}

function HistoryList({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const history = useStaffHistory(current.outlet.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const orders = history.data?.pages.flatMap((p) => p.orders) ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-extrabold">History · {current.outlet.name}</h1>
        <OutletPicker outlets={outlets} selectedId={current.outlet.id} onSelect={select} />
      </div>
      {history.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : history.error ? (
        <ErrorState
          error={history.error}
          onRetry={() => void history.refetch()}
          retrying={history.isFetching}
        />
      ) : orders.length === 0 ? (
        <EmptyState icon={<History aria-hidden />} title="No finished orders yet" />
      ) : (
        <div className="rounded-(--radius-panel) border border-espresso-100 bg-cream-50">
          <ul aria-label="Finished orders">
            {orders.map((order) => (
              <li key={order.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(order.id)}
                  className="flex w-full flex-wrap items-center gap-3 border-b border-dashed border-espresso-100 px-4 py-3 text-left last:border-b-0 hover:bg-cream-200/50"
                >
                  <span className="w-20 font-display text-xl font-extrabold tabular">
                    {order.pickupCode}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">
                      {statusLabels[order.status].split(' — ')[0]}
                    </span>
                    <span className="block text-espresso-500">
                      {order.customer.displayName} · {formatDateTime(order.placedAt)}
                    </span>
                  </span>
                  <span className="tabular font-semibold">{formatINR(order.totalPaise)}</span>
                  <PaymentBadge order={order} />
                </button>
              </li>
            ))}
          </ul>
          {history.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void history.fetchNextPage()}
                loading={history.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      <OrderActionsDialog
        outletId={current.outlet.id}
        orderId={openId}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

export function PosHistoryPage() {
  return <StaffGate role="POS">{(ctx) => <HistoryList {...ctx} />}</StaffGate>;
}
