import type { ReactNode } from 'react';
import { CalendarClock, Clock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatINR } from '@/lib/money';
import { timeAgo } from '@/lib/time';
import type { StaffOrderSummary } from '@/services/staff';
import { PaymentBadge } from './PaymentBadge';
import { dueIn, formatClock, formatSlot, isPastDue } from '@/features/scheduling/schedule-format';

/** A queue ticket: pickup code first, because that's what staff call out. */
export function OrderCard({
  order,
  onOpen,
  action,
  large = false,
}: {
  order: StaffOrderSummary;
  onOpen: () => void;
  action?: ReactNode;
  large?: boolean;
}) {
  return (
    <article
      aria-label={`Order ${order.pickupCode}`}
      className="flex flex-col gap-3 rounded-(--radius-control) border border-espresso-100 bg-cream-50 p-3 shadow-press"
    >
      <button type="button" onClick={onOpen} className="flex flex-col gap-1 text-left">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'font-display font-extrabold text-espresso-900 tabular',
              large ? 'text-3xl' : 'text-2xl',
            )}
          >
            {/* Named by its content so the spoken name matches what's on screen (WCAG 2.5.3). */}
            <span className="sr-only">Open order</span> {order.pickupCode}
          </span>
          <span className="flex items-center gap-1 text-xs text-espresso-500">
            <Clock className="size-3" aria-hidden />
            {timeAgo(order.placedAt)}
          </span>
        </span>
        {order.timing === 'SCHEDULED' && order.scheduledFor && (
          <span
            className={cn(
              'flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
              isPastDue(order.scheduledFor)
                ? 'bg-chili-50 text-chili-700'
                : 'bg-mustard-50 text-mustard-800',
            )}
          >
            <CalendarClock className="size-3.5" aria-hidden />
            Scheduled · {formatSlot(order.scheduledFor)} · {dueIn(order.scheduledFor)}
          </span>
        )}
        {order.status === 'READY' && order.pickupDeadline && (
          <span className="text-xs font-semibold text-espresso-700">
            {isPastDue(order.pickupDeadline)
              ? 'Grace period over — no-show processing'
              : `Collect by ${formatClock(order.pickupDeadline)} (${dueIn(order.pickupDeadline).replace('in ', '')} left)`}
          </span>
        )}
        {order.estimate && (
          <span
            className={cn(
              'w-fit rounded-full px-2 py-0.5 text-xs font-semibold',
              order.estimate.delayed
                ? 'bg-chili-50 text-chili-700'
                : 'bg-cream-200 text-espresso-700',
            )}
          >
            {order.estimate.delayed && 'Delayed · '}
            {order.estimate.queuePosition === 0
              ? 'Preparing'
              : `Queue #${order.estimate.queuePosition}`}{' '}
            · ready ~{formatClock(order.estimate.predictedReadyAt)}
          </span>
        )}
        <span className="text-sm text-espresso-700">
          {order.customer.displayName} · {order.itemCount}{' '}
          {order.itemCount === 1 ? 'item' : 'items'} ·{' '}
          <span className="tabular">{formatINR(order.totalPaise)}</span>
        </span>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PaymentBadge order={order} />
        {action}
      </div>
    </article>
  );
}
