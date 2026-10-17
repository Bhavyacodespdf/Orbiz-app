import { Ban, Clock, PackageCheck, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { formatINR } from '@/lib/money';
import type { Order } from '@/services/orders';
import { formatClock } from '@/features/scheduling/schedule-format';

/** Packaged / Handmade chip for an order line (the classification it was ordered with). */
export function FulfillmentChip({ type }: { type: 'PACKAGED' | 'HANDMADE' | null }) {
  if (type === 'PACKAGED') return <Badge tone="success">Packaged</Badge>;
  if (type === 'HANDMADE') return <Badge tone="neutral">Handmade</Badge>;
  return <Badge tone="neutral">Not classified</Badge>;
}

const ACTIVE = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'];

/**
 * The pickup deadline (slot + 10 minutes) and, once it has passed, what's happening. Never
 * claims a refund until the server has recorded it.
 */
export function PickupDeadline({
  order,
  audience,
  nowMs,
}: {
  order: Pick<
    Order,
    'timing' | 'status' | 'pickupDeadline' | 'noShow' | 'paymentMethod' | 'paymentStatus'
  >;
  audience: 'student' | 'staff';
  nowMs: number;
}) {
  if (order.timing !== 'SCHEDULED' || !order.pickupDeadline || !ACTIVE.includes(order.status))
    return null;
  const deadline = Date.parse(order.pickupDeadline);
  const passed = nowMs >= deadline;
  if (!passed) {
    return (
      <p className="flex items-center gap-2 text-sm text-espresso-700">
        <Timer className="size-4 shrink-0" aria-hidden />
        Collect by <strong>{formatClock(order.pickupDeadline)}</strong> (10 minutes after the pickup
        time).
      </p>
    );
  }
  if (order.status !== 'READY') {
    return audience === 'staff' ? (
      <p
        role="status"
        className="rounded-(--radius-control) bg-chili-50 px-3 py-2 text-sm text-chili-700"
      >
        Pickup deadline passed before this order was ready. It needs staff attention — the no-show
        policy only applies to orders that were ready.
      </p>
    ) : null;
  }
  if (order.paymentMethod === 'COUNTER' && order.paymentStatus === 'PAID') {
    // Cash was taken at the counter; the app can't refund it, so this is never automatic.
    return (
      <p
        role="status"
        className="rounded-(--radius-control) bg-chili-50 px-3 py-2 text-sm text-chili-700"
      >
        {audience === 'staff'
          ? 'Grace period over, but this order was paid in cash at the counter. It needs staff attention: settle it in person.'
          : 'This order wasn’t collected in time. It was paid at the counter, so please speak to the counter staff.'}
      </p>
    );
  }
  const failed = order.noShow?.status === 'FAILED';
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-(--radius-control) bg-mustard-50 px-3 py-2 text-sm text-mustard-800"
    >
      <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
      {audience === 'student'
        ? 'This order wasn’t collected in time, so the no-show policy is being applied. Any refund will show here and in your wallet once it’s done.'
        : failed
          ? 'Automatic no-show processing failed and will be retried. An administrator can retry it now.'
          : 'Grace period over — awaiting automatic no-show processing. Confirming pickup now still works if it hasn’t run yet.'}
    </p>
  );
}

/** What the no-show policy did, line by line, from the server's settlement. */
export function NoShowOutcome({
  order,
  audience,
}: {
  order: Order;
  audience: 'student' | 'staff';
}) {
  if (order.status !== 'NO_SHOW' || order.noShow?.status !== 'PROCESSED') return null;
  const s = order.noShow;
  const paid = order.paymentMethod === 'WALLET';
  return (
    <section
      aria-labelledby="noshow-heading"
      className="flex flex-col gap-2 rounded-(--radius-control) border border-espresso-100 bg-cream-200/60 p-3 text-sm"
    >
      <h3 id="noshow-heading" className="flex items-center gap-2 font-sans font-bold">
        <Ban className="size-4" aria-hidden />
        Not collected — no-show policy applied
      </h3>
      <ul className="flex flex-col gap-1.5">
        {order.items.map((item) => (
          <li key={item.menuItemId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">
              {item.quantity} × {item.name}
            </span>
            <FulfillmentChip type={item.fulfillmentType} />
            <span className="text-espresso-700">
              {!paid
                ? 'Nothing was charged.'
                : item.fulfillmentType === 'PACKAGED'
                  ? `${formatINR(item.noShow?.refundPaise ?? 0)} refunded · ${formatINR(item.noShow?.feePaise ?? 0)} convenience fee (10%) kept`
                  : 'No refund — made to order.'}
              {audience === 'staff' && item.noShow && item.noShow.restockedQuantity > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 text-success-600">
                  <PackageCheck className="size-3.5" aria-hidden />
                  {item.noShow.restockedQuantity} restocked
                </span>
              )}
              {audience === 'staff' &&
                item.unsuitableForResale &&
                ' · not resellable, not restocked'}
            </span>
          </li>
        ))}
      </ul>
      {paid && (
        <p className="border-t border-dashed border-espresso-200 pt-2">
          {s.refundPaise > 0 ? (
            <>
              <strong>{formatINR(s.refundPaise)}</strong> refunded to the CampusCart wallet
              (simulated funds).
            </>
          ) : (
            'No refund under the no-show policy.'
          )}{' '}
          {s.scheduledFeeRetainedPaise > 0 &&
            `The ${formatINR(s.scheduledFeeRetainedPaise)} scheduled-order fee is kept.`}
        </p>
      )}
    </section>
  );
}
