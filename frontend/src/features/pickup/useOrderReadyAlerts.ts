import { useEffect } from 'react';
import { useToast } from '@/components/feedback/toast-context';
import { onOrderReady } from '@/services/realtime';

/** "Order N-007 is ready" for the student, over the live connection. Never shows the code. */
export function useOrderReadyAlerts() {
  const toast = useToast();
  useEffect(
    () =>
      onOrderReady((event) =>
        toast.show({
          tone: 'success',
          title: `Order ${event.pickupCode} is ready`,
          description: `Collect it at ${event.outletName}: open the order in Orders to show your pickup code.`,
        }),
      ),
    [toast],
  );
}
