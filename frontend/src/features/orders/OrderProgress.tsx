import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OrderStatus } from '@/services/orders';

const STEPS: { status: OrderStatus; label: string }[] = [
  { status: 'PLACED', label: 'Placed' },
  { status: 'ACCEPTED', label: 'Accepted' },
  { status: 'PREPARING', label: 'Preparing' },
  { status: 'READY', label: 'Ready' },
  { status: 'COMPLETED', label: 'Collected' },
];

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/**
 * Where the order is in its lifecycle, from the server's persisted status. With `history`, each
 * stage the order actually reached shows the time it happened (from OrderStatusHistory) — a
 * stage is never marked with a time it didn't record.
 */
export function OrderProgress({
  status,
  history,
}: {
  status: OrderStatus;
  history?: { toStatus: OrderStatus; at: string }[];
}) {
  const current = STEPS.findIndex((s) => s.status === status);
  const reachedAt = new Map(history?.map((h) => [h.toStatus, h.at]));
  if (current === -1) return null; // rejected / cancelled orders show a notice instead
  return (
    <ol aria-label="Order progress" className="flex items-center">
      {STEPS.map((step, index) => {
        const done = index < current || status === 'COMPLETED';
        const active = index === current && status !== 'COMPLETED';
        return (
          <li
            key={step.status}
            className="flex flex-1 flex-col items-center gap-1.5 last:flex-none"
            aria-current={active ? 'step' : undefined}
          >
            <div className="flex w-full items-center">
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full border-2 text-xs font-bold',
                  done && 'border-success-600 bg-success-600 text-white',
                  active && 'border-chili-500 bg-chili-500 text-white animate-pulse',
                  !done && !active && 'border-espresso-200 bg-cream-50 text-espresso-500',
                )}
              >
                {done ? <Check className="size-4" aria-hidden /> : index + 1}
              </span>
              {index < STEPS.length - 1 && (
                <span
                  className={cn(
                    'h-0.5 flex-1',
                    index < current ? 'bg-success-600' : 'bg-espresso-100',
                  )}
                  aria-hidden
                />
              )}
            </div>
            <span
              className={cn(
                'text-xs font-semibold',
                active ? 'text-chili-600' : 'text-espresso-500',
              )}
            >
              {step.label}
            </span>
            {reachedAt.has(step.status) && (
              <time
                dateTime={reachedAt.get(step.status)}
                className="text-[0.7rem] text-espresso-500 tabular"
              >
                {clock(reachedAt.get(step.status)!)}
              </time>
            )}
          </li>
        );
      })}
    </ol>
  );
}
