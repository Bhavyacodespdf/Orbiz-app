import { Badge } from '@/components/ui/Badge';
import { formatINR } from '@/lib/money';
import type { OrderSummary } from '@/services/orders';

/** Payment state as staff need it: paid, or how much to collect. */
export function PaymentBadge({
  order,
}: {
  order: Pick<OrderSummary, 'paymentMethod' | 'paymentStatus' | 'totalPaise'>;
}) {
  if (order.paymentStatus === 'PAID') {
    return (
      <Badge tone="success">
        {order.paymentMethod === 'WALLET'
          ? 'Paid · wallet'
          : order.paymentMethod === 'GROUP'
            ? 'Paid · group'
            : 'Paid · counter'}
      </Badge>
    );
  }
  if (order.paymentStatus === 'PENDING_COUNTER') {
    return <Badge tone="mustard">Collect {formatINR(order.totalPaise)}</Badge>;
  }
  if (order.paymentStatus === 'REFUNDED') return <Badge>Refunded</Badge>;
  if (order.paymentStatus === 'PARTIALLY_REFUNDED') return <Badge>Part refunded</Badge>;
  return <Badge>Not charged</Badge>;
}
