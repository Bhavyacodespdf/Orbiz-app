import { Clock, Users } from 'lucide-react';
import type { Order } from '@/services/orders';
import { useOrderTracking } from '@/services/kitchen';
import { useNow } from '@/features/noshow/useNow';

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/**
 * Queue position and estimated ready time for an order still in the kitchen. Position is an
 * ordering; the time is an estimate and says so. Once ready, the real time is shown instead.
 */
export function TrackingEstimate({ order }: { order: Order }) {
  const tracking = useOrderTracking(order.id, order.status);
  const nowMs = useNow(30_000);
  const t = tracking.data;
  if (!t) return null;

  if (t.readyAt && (order.status === 'READY' || order.status === 'COMPLETED')) {
    return (
      <p className="flex items-center gap-2 text-sm text-espresso-700">
        <Clock className="size-4 shrink-0" aria-hidden />
        Ready at {clock(t.readyAt)}
      </p>
    );
  }
  const e = t.estimate;
  if (!e) return null;
  const minutesLeft = Math.max(
    0,
    Math.round((new Date(e.predictedReadyAt).getTime() - nowMs) / 60_000),
  );
  return (
    <section
      aria-labelledby="estimate-heading"
      className="flex flex-col gap-1.5 rounded-(--radius-control) bg-cream-200 px-3 py-2.5 text-sm"
    >
      <h2 id="estimate-heading" className="sr-only">
        Queue and estimated ready time
      </h2>
      {e.queuePosition !== null && (
        <p className="flex items-center gap-2 text-espresso-900">
          <Users className="size-4 shrink-0" aria-hidden />
          {e.queuePosition === 0
            ? 'Being prepared now'
            : `${e.ordersAhead === 0 ? 'Next in line' : `${e.ordersAhead} ${e.ordersAhead === 1 ? 'order' : 'orders'} ahead of yours`}`}
        </p>
      )}
      <p className="flex items-center gap-2 font-semibold text-espresso-900">
        <Clock className="size-4 shrink-0" aria-hidden />
        {e.rangeMinutes !== null
          ? `Estimated ready around ${clock(e.predictedReadyAt)} (± ${e.rangeMinutes} min)`
          : `Estimated ready around ${clock(e.predictedReadyAt)} — about ${minutesLeft} min (approximate)`}
      </p>
      {e.awaitingAcceptance && (
        <p className="text-xs text-espresso-500">
          The outlet hasn’t accepted your order yet; this assumes it does now.
        </p>
      )}
    </section>
  );
}
