import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Receipt-style surface with a perforated bottom edge. Used for order
 * confirmations and live order tracking.
 */
export function Ticket({
  header,
  children,
  className,
}: {
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('drop-shadow-[0_6px_14px_rgb(43_30_26/0.12)]', className)}>
      <div className="perforated bg-cream-50 pb-6">
        {header && (
          <div className="border-b-2 border-dashed border-espresso-100 px-5 py-4">{header}</div>
        )}
        <div className="px-5 pt-4">{children}</div>
      </div>
    </div>
  );
}

/** One "label …… value" line on a ticket. */
export function TicketLine({
  label,
  value,
  emphasis = false,
}: {
  label: ReactNode;
  value: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 py-1',
        emphasis ? 'text-lg font-bold' : 'text-espresso-700',
      )}
    >
      <span>{label}</span>
      <span className="mb-1 flex-1 border-b border-dotted border-espresso-200" aria-hidden />
      <span className="tabular">{value}</span>
    </div>
  );
}
