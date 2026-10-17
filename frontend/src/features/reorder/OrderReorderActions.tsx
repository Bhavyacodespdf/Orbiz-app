import { useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { Order } from '@/services/orders';
import { CustomizeDialog } from './CustomizeDialog';
import { useReorderFlow } from './useReorderFlow';

/** Reorder / Customize on a collected order's page (not for group orders). */
export function OrderReorderActions({ order }: { order: Order }) {
  const flow = useReorderFlow();
  const [customizing, setCustomizing] = useState(false);
  if (order.status !== 'COMPLETED' || order.paymentMethod === 'GROUP') return null;
  const source = { type: 'ORDER' as const, orderId: order.id };
  return (
    <>
      <Button
        size="sm"
        loading={flow.busy}
        icon={<RotateCcw className="size-3.5" aria-hidden />}
        onClick={() => flow.start({ orderId: order.id }, source, 'Reorder this order')}
      >
        Reorder
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={<SlidersHorizontal className="size-3.5" aria-hidden />}
        onClick={() => setCustomizing(true)}
      >
        Customize
      </Button>
      {customizing && (
        <CustomizeDialog
          title={`Order ${order.pickupCode}`}
          outletSlug={order.outlet.slug}
          initialItems={order.items.map((i) => ({
            menuItemId: i.menuItemId,
            quantity: i.quantity,
          }))}
          source={source}
          flow={flow}
          onClose={() => setCustomizing(false)}
        />
      )}
      {flow.dialogs}
    </>
  );
}
