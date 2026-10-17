import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/feedback/Skeleton';
import { StatusSign } from '@/components/ui/StatusSign';
import { useStaffQueue, type QueueFilter, type StaffOutlet } from '@/services/staff';
import type { OrderStatus } from '@/services/orders';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { OrderCard } from '@/features/staff/OrderCard';
import { OrderActionsDialog } from '@/features/staff/OrderActionsDialog';
import { VerifyPickupDialog } from '@/features/pickup/VerifyPickupDialog';
import { Button } from '@/components/ui/Button';
import { QrCode } from 'lucide-react';
import { QueueFilterChips } from '@/features/staff/QueueFilter';
import { useNewOrderAlerts } from '@/features/staff/useNewOrderAlerts';

const COLUMNS: { status: OrderStatus; label: string; accent: string }[] = [
  { status: 'PLACED', label: 'New', accent: 'bg-chili-500' },
  { status: 'ACCEPTED', label: 'Accepted', accent: 'bg-mustard-500' },
  { status: 'PREPARING', label: 'Preparing', accent: 'bg-mustard-700' },
  { status: 'READY', label: 'Ready for pickup', accent: 'bg-success-600' },
];

function Board({
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  useNewOrderAlerts(outletId);

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Order board"
        description={
          <span className="flex flex-wrap items-center gap-2">
            {current.outlet.name} <StatusSign status={current.outlet.status} />
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => setVerifying(true)}
              icon={<QrCode className="size-4" aria-hidden />}
            >
              Verify pickup
            </Button>
            <OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />
          </div>
        }
      />
      <QueueFilterChips value={filter} onChange={setFilter} />
      <div className="mb-4" />
      {queue.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : queue.error ? (
        <ErrorState
          error={queue.error}
          onRetry={() => void queue.refetch()}
          retrying={queue.isFetching}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => {
            const orders = queue.data.filter((o) => o.status === column.status);
            return (
              <section
                key={column.status}
                aria-label={column.label}
                className="flex min-h-28 flex-col gap-2 rounded-(--radius-panel) bg-cream-200/70 p-3 sm:min-h-48"
              >
                <h2 className="flex items-center gap-2 px-1 pb-1 font-sans text-sm font-bold tracking-wider text-espresso-700 uppercase">
                  <span className={`size-2 rounded-full ${column.accent}`} aria-hidden />
                  {column.label}
                  <span className="ml-auto rounded-full bg-cream-50 px-2 text-xs tabular">
                    {orders.length}
                  </span>
                </h2>
                {orders.length === 0 ? (
                  <p className="m-auto px-2 text-center text-sm text-espresso-500">No orders</p>
                ) : (
                  orders.map((order) => (
                    <OrderCard key={order.id} order={order} onOpen={() => setOpenId(order.id)} />
                  ))
                )}
              </section>
            );
          })}
        </div>
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
    </>
  );
}

export function ManagerOrdersPage() {
  return <StaffGate role="MANAGER">{(ctx) => <Board {...ctx} />}</StaffGate>;
}
