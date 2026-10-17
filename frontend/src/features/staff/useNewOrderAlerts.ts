import { useEffect } from 'react';
import { useToast } from '@/components/feedback/toast-context';
import { onOrderCreated } from '@/services/realtime';

/** Shows an alert when a real new order arrives for this outlet over the live connection. */
export function useNewOrderAlerts(outletId: string) {
  const toast = useToast();
  useEffect(
    () =>
      onOrderCreated((event) => {
        if (event.outletId === outletId) {
          toast.show({
            tone: 'info',
            title: `New order ${event.pickupCode}`,
            description: 'Added to the queue.',
          });
        }
      }),
    [outletId, toast],
  );
}
