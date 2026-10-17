import { useSearchParams, Link } from 'react-router';
import { ChevronRight, ListOrdered } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { ConnectionStatus } from '@/components/feedback/ConnectionStatus';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/cn';
import { useRealtimeStatus } from '@/services/realtime';
import { useOrders, type OrderSummary } from '@/services/orders';
import { formatSlot } from '@/features/scheduling/schedule-format';
import { statusLabels } from './order-labels';

const tabs = [
  { view: 'active', label: 'In progress' },
  { view: 'past', label: 'Past orders' },
] as const;

function OrderRow({ order }: { order: OrderSummary }) {
  const ended =
    order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'NO_SHOW';
  return (
    <li>
      <Link
        to={`/orders/${order.id}`}
        className="flex items-center gap-4 border-b border-dashed border-espresso-100 px-4 py-4 transition-colors last:border-b-0 hover:bg-cream-200/50"
      >
        <span className="font-display text-xl font-extrabold text-chili-600 tabular">
          {order.pickupCode}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{order.outlet.name}</span>
          <span className="block text-sm text-espresso-500">
            {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} ·{' '}
            {formatINR(order.totalPaise)} ·{' '}
            {order.timing === 'SCHEDULED' && order.scheduledFor
              ? `Pickup ${formatSlot(order.scheduledFor)}`
              : new Date(order.placedAt).toLocaleString('en-IN', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
          </span>
        </span>
        <Badge
          tone={ended ? 'chili' : order.status === 'READY' ? 'success' : 'dark'}
          className="hidden sm:inline-flex"
        >
          {statusLabels[order.status].split(' — ')[0]}
        </Badge>
        <ChevronRight className="size-4 shrink-0 text-espresso-500" aria-hidden />
      </Link>
    </li>
  );
}

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'past' ? 'past' : 'active';
  const orders = useOrders(view);
  const realtime = useRealtimeStatus();
  const list = orders.data?.pages.flatMap((p) => p.orders) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Your orders"
        title="Orders"
        description="Statuses update live while you’re connected."
        actions={<ConnectionStatus state={realtime} />}
      />

      <div role="tablist" aria-label="Order lists" className="mb-4 flex gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.view}
            type="button"
            role="tab"
            aria-selected={view === tab.view}
            onClick={() =>
              setParams(tab.view === 'active' ? {} : { view: tab.view }, { replace: true })
            }
            className={cn(
              'h-10 rounded-full border px-4 text-sm font-semibold transition-colors',
              view === tab.view
                ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                : 'border-espresso-200 bg-cream-50 text-espresso-700 hover:border-espresso-400',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {orders.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((n) => (
              <Skeleton key={n} className="h-16" />
            ))}
          </div>
        ) : orders.error ? (
          <ErrorState
            error={orders.error}
            onRetry={() => void orders.refetch()}
            retrying={orders.isFetching}
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<ListOrdered aria-hidden />}
            title={view === 'active' ? 'Nothing in progress' : 'No past orders yet'}
            description={
              view === 'active'
                ? 'Orders you place will appear here while they’re being prepared.'
                : undefined
            }
            action={view === 'active' ? <ButtonLink to="/">Browse outlets</ButtonLink> : undefined}
          />
        ) : (
          <Panel>
            <ul aria-label={view === 'active' ? 'Orders in progress' : 'Past orders'}>
              {list.map((order) => (
                <OrderRow key={order.id} order={order} />
              ))}
            </ul>
            {orders.hasNextPage && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void orders.fetchNextPage()}
                  loading={orders.isFetchingNextPage}
                >
                  Load more
                </Button>
              </div>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
