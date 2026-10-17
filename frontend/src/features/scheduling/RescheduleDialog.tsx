import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/feedback/Skeleton';
import { describeError } from '@/lib/errors';
import { useSlots } from '@/services/scheduling';
import { useRescheduleOrder, type Order } from '@/services/orders';
import { SlotPicker } from './SlotPicker';
import { formatSlot } from './schedule-format';

/** Move a still-waiting scheduled order to another pickup slot. No extra fee. */
export function RescheduleDialog({
  order,
  onDone,
  onClose,
}: {
  order: Order;
  onDone: () => void;
  onClose: () => void;
}) {
  const slots = useSlots(order.outlet.slug);
  const reschedule = useRescheduleOrder();
  const [slot, setSlot] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change pickup time"
      description={`Now: ${order.scheduledFor ? formatSlot(order.scheduledFor) : ''}. There’s no extra charge for changing it.`}
    >
      <div className="flex flex-col gap-4">
        {slots.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : slots.error ? (
          <p role="alert" className="text-sm text-chili-700">
            {describeError(slots.error)}
          </p>
        ) : (
          <SlotPicker options={slots.data} value={slot} onChange={setSlot} nowMs={nowMs} />
        )}
        {reschedule.error ? (
          <p role="alert" className="text-sm font-medium text-chili-600">
            {describeError(reschedule.error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={reschedule.isPending}>
            Keep current time
          </Button>
          <Button
            disabled={!slot}
            loading={reschedule.isPending}
            onClick={() =>
              slot &&
              reschedule.mutate({ orderId: order.id, scheduledFor: slot }, { onSuccess: onDone })
            }
          >
            Save new time
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
