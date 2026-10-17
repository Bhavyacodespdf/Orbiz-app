import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, CalendarClock, CircleCheck, ReceiptText, RefreshCw, Store } from 'lucide-react';
import { Ticket, TicketLine } from '@/components/ui/Ticket';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ConnectionStatus } from '@/components/feedback/ConnectionStatus';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { ApiError } from '@/services/http';
import { useRealtimeStatus } from '@/services/realtime';
import { useCancelOrder, useOrder, type Order } from '@/services/orders';
import { statusLabels } from './order-labels';
import { OrderProgress } from './OrderProgress';
import { RescheduleDialog } from '@/features/scheduling/RescheduleDialog';
import { formatSlot } from '@/features/scheduling/schedule-format';
import { OrderTotals } from './OrderTotals';
import { NoShowOutcome, PickupDeadline } from '@/features/noshow/NoShowPanel';
import { useNow } from '@/features/noshow/useNow';
import { feeKeptNote, pointsReturnNote } from './order-labels';
import { itemPath } from '@/features/reviews/review-labels';
import { OrderReorderActions } from '@/features/reorder/OrderReorderActions';
import { PickupPanel } from '@/features/pickup/PickupPanel';
import { TrackingEstimate } from '@/features/kitchen/TrackingEstimate';

function paymentLine(order: Order): { text: string; tone: 'success' | 'mustard' | 'neutral' } {
  if (order.paymentMethod === 'GROUP') {
    return order.paymentStatus === 'REFUNDED'
      ? {
          text: 'Every member’s share was refunded to their wallet (simulated funds)',
          tone: 'neutral',
        }
      : { text: 'Paid in shares by the group (simulated test funds)', tone: 'success' };
  }
  if (order.paymentMethod === 'WALLET') {
    if (order.paymentStatus === 'PARTIALLY_REFUNDED') {
      return {
        text: `${formatINR(order.noShow?.refundPaise ?? 0)} refunded to your wallet under the no-show policy (simulated funds)`,
        tone: 'neutral',
      };
    }
    return order.paymentStatus === 'REFUNDED'
      ? {
          text: `${formatINR(order.refundPaise)} refunded to your wallet (simulated funds)${
            feeKeptNote(order) ? `.${feeKeptNote(order)}` : ''
          }`,
          tone: 'neutral',
        }
      : { text: 'Paid from wallet (simulated test funds)', tone: 'success' };
  }
  if (order.paymentStatus === 'PAID') return { text: 'Paid at the counter', tone: 'success' };
  if (order.paymentStatus === 'VOID') return { text: 'Not charged', tone: 'neutral' };
  return {
    text: `Pay ${formatINR(order.totalPaise)} at the counter when you collect — not paid yet`,
    tone: 'mustard',
  };
}

export function OrderPage() {
  const { orderId = '' } = useParams();
  const order = useOrder(orderId);
  const cancel = useCancelOrder();
  const [rescheduling, setRescheduling] = useState(false);
  const nowMs = useNow();
  const toast = useToast();
  const realtime = useRealtimeStatus();
  const [confirming, setConfirming] = useState(false);

  if (order.isPending) return <Skeleton className="mx-auto h-96 w-full max-w-lg" />;
  if (order.error) {
    if (order.error instanceof ApiError && order.error.status === 404) {
      return (
        <EmptyState
          icon={<ReceiptText aria-hidden />}
          title="Order not found"
          action={<ButtonLink to="/orders">Your orders</ButtonLink>}
        />
      );
    }
    return (
      <ErrorState
        error={order.error}
        onRetry={() => void order.refetch()}
        retrying={order.isFetching}
      />
    );
  }

  const o = order.data;
  const payment = paymentLine(o);
  const ended = o.status === 'REJECTED' || o.status === 'CANCELLED' || o.status === 'NO_SHOW';

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5">
      {o.status === 'PLACED' && (
        <div className="flex items-center gap-2 font-semibold text-success-600">
          <CircleCheck className="size-5" aria-hidden />
          {o.timing === 'SCHEDULED' ? 'Order scheduled' : 'Order placed'}
        </div>
      )}

      <Ticket
        header={
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-xs font-bold tracking-[0.18em] text-espresso-500 uppercase">
              Order number
            </p>
            <p className="font-display text-6xl font-extrabold tracking-tight text-chili-600 tabular">
              {o.pickupCode}
            </p>
            <p className="font-semibold">{o.outlet.name}</p>
            {o.outlet.location && <p className="text-sm text-espresso-500">{o.outlet.location}</p>}
          </div>
        }
      >
        <div className="mb-4 flex flex-col gap-3" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={ended ? 'chili' : o.status === 'READY' ? 'success' : 'dark'}>
              {statusLabels[o.status]}
            </Badge>
            <time dateTime={o.placedAt} className="text-sm text-espresso-500">
              {new Date(o.placedAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </div>
          {o.timing === 'SCHEDULED' && o.scheduledFor && (
            <p className="flex flex-wrap items-center gap-2 rounded-(--radius-control) bg-mustard-50 px-3 py-2 text-sm text-mustard-800">
              <CalendarClock className="size-4 shrink-0" aria-hidden />
              <span>
                Scheduled pickup: <strong>{formatSlot(o.scheduledFor)}</strong> (IST)
              </span>
              {o.status === 'PLACED' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setRescheduling(true)}
                >
                  Change time
                </Button>
              )}
            </p>
          )}
          <PickupDeadline order={o} audience="student" nowMs={nowMs} />
          <NoShowOutcome order={o} audience="student" />
          <OrderProgress status={o.status} history={o.statusHistory} />
          <TrackingEstimate order={o} />
          {ended && (
            <p className="flex items-start gap-2 rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700">
              <Ban className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {o.status === 'REJECTED'
                  ? 'The outlet couldn’t take this order.'
                  : 'This order was cancelled.'}
                {o.cancelReason && <> Reason: “{o.cancelReason}”.</>}
              </span>
            </p>
          )}
        </div>
        {o.items.map((item) => (
          <TicketLine
            key={item.menuItemId}
            label={`${item.quantity} × ${item.name}`}
            value={formatINR(item.lineTotalPaise)}
          />
        ))}
        <OrderTotals order={o} />
        <p className="mt-3">
          <Badge tone={payment.tone}>{payment.text}</Badge>
        </p>
      </Ticket>

      <PickupPanel order={o} />

      {o.status === 'COMPLETED' && o.paymentStatus === 'PAID' && (
        <section aria-labelledby="rate-heading" className="flex flex-col gap-2">
          <h2 id="rate-heading" className="text-lg font-bold">
            Rate your food
          </h2>
          <ul className="flex flex-col divide-y divide-dashed divide-espresso-100 rounded-(--radius-control) border border-espresso-100 bg-cream-50">
            {o.items.map((item) => (
              <li
                key={item.menuItemId}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0 truncate">{item.name}</span>
                <ButtonLink
                  to={itemPath(o.outlet.slug, item.menuItemId)}
                  variant="secondary"
                  size="sm"
                  aria-label={`Rate ${item.name}`}
                >
                  Rate
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <ConnectionStatus state={realtime} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void order.refetch()}
          loading={order.isFetching}
          icon={<RefreshCw className="size-4" aria-hidden />}
        >
          Refresh
        </Button>
      </div>
      {realtime !== 'live' && (
        <p className="text-sm text-espresso-500">
          Not receiving live updates right now — showing the last status saved on the server. Use
          Refresh to check again.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <OrderReorderActions order={o} />
        {o.status === 'PLACED' && (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Cancel order
          </Button>
        )}
        <ButtonLink to={`/outlets/${o.outlet.slug}`} variant="secondary" size="sm">
          <Store className="size-4" aria-hidden />
          {o.outlet.name}
        </ButtonLink>
        <Link
          to="/orders"
          className="inline-flex h-9 items-center px-3 text-sm font-semibold text-chili-600 hover:underline"
        >
          All orders
        </Link>
      </div>

      {rescheduling && (
        <RescheduleDialog
          order={o}
          onClose={() => setRescheduling(false)}
          onDone={() => {
            setRescheduling(false);
            toast.show({ tone: 'success', title: 'Pickup time changed' });
          }}
        />
      )}
      <ConfirmDialog
        open={confirming}
        title="Cancel this order?"
        description={
          o.paymentMethod === 'GROUP'
            ? 'Every member’s share will be refunded to their own wallet straight away.'
            : o.paymentMethod === 'WALLET'
              ? `${formatINR(o.refundPaise)} will be returned to your wallet straight away.${feeKeptNote(o)}${pointsReturnNote(o)}`
              : `You haven’t paid for this order, so nothing will be charged.${pointsReturnNote(o)}`
        }
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        destructive
        loading={cancel.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          cancel.mutate(
            { orderId: o.id },
            {
              onSuccess: (updated) => {
                setConfirming(false);
                toast.show({
                  tone: 'success',
                  title: 'Order cancelled',
                  description:
                    updated.paymentStatus === 'REFUNDED'
                      ? 'The refund is in your wallet.'
                      : undefined,
                });
              },
              onError: (error) => {
                setConfirming(false);
                void order.refetch();
                toast.show({
                  tone: 'error',
                  title: 'Couldn’t cancel',
                  description: describeError(error),
                });
              },
            },
          )
        }
      />
    </div>
  );
}
