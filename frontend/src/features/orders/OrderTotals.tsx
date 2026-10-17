import { Price } from '@/components/ui/Price';
import { TicketLine } from '@/components/ui/Ticket';
import { formatINR } from '@/lib/money';
import type { Order } from '@/services/orders';

const pointsLabel = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;

/** Subtotal, any loyalty-points discount, and the total actually charged — all from the server. */
export function OrderTotals({
  order,
}: {
  order: Pick<
    Order,
    'subtotalPaise' | 'pointsRedeemed' | 'pointsDiscountPaise' | 'scheduledFeePaise' | 'totalPaise'
  >;
}) {
  const breakdown = order.pointsDiscountPaise > 0 || order.scheduledFeePaise > 0;
  return (
    <>
      {breakdown && <TicketLine label="Food subtotal" value={formatINR(order.subtotalPaise)} />}
      {order.pointsDiscountPaise > 0 && (
        <TicketLine
          label={`Loyalty points (${pointsLabel(order.pointsRedeemed)})`}
          value={`−${formatINR(order.pointsDiscountPaise)}`}
        />
      )}
      {order.scheduledFeePaise > 0 && (
        <TicketLine label="Scheduled-order fee" value={formatINR(order.scheduledFeePaise)} />
      )}
      <TicketLine
        label={breakdown ? 'Total paid' : 'Total'}
        value={<Price paise={order.totalPaise} />}
        emphasis
      />
    </>
  );
}
