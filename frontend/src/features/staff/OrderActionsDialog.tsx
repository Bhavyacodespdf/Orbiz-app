import { useState } from 'react';
import { Banknote, QrCode } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { TextField } from '@/components/ui/TextField';
import { TicketLine } from '@/components/ui/Ticket';
import { Spinner } from '@/components/feedback/Spinner';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import type { OrderStatus } from '@/services/orders';
import {
  useRecordCounterPayment,
  useMarkNotResellable,
  useStaffOrder,
  useTransitionOrder,
} from '@/services/staff';
import { statusLabels } from '@/features/orders/order-labels';
import { actionLabels, needsReason } from './order-actions';
import { OrderTotals } from '@/features/orders/OrderTotals';
import { feeKeptNote, pointsReturnNote } from '@/features/orders/order-labels';
import { formatSlot } from '@/features/scheduling/schedule-format';
import { FulfillmentChip, NoShowOutcome, PickupDeadline } from '@/features/noshow/NoShowPanel';
import { useNow } from '@/features/noshow/useNow';
import { PaymentBadge } from './PaymentBadge';

export function OrderActionsDialog({
  outletId,
  orderId,
  onClose,
  onVerifyPickup,
}: {
  outletId: string;
  orderId: string | null;
  onClose: () => void;
  /** Opens Verify Pickup (handover needs the student's code). */
  onVerifyPickup?: () => void;
}) {
  const order = useStaffOrder(outletId, orderId);
  const transition = useTransitionOrder(outletId);
  const payment = useRecordCounterPayment(outletId);
  const notResellable = useMarkNotResellable(outletId);
  const [flagging, setFlagging] = useState<{ menuItemId: string; name: string } | null>(null);
  const [flagReason, setFlagReason] = useState('');
  const nowMs = useNow();
  const toast = useToast();
  const [pending, setPending] = useState<OrderStatus | 'PAYMENT' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPending(null);
    setReason('');
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  function move(to: OrderStatus) {
    if (!order.data) return;
    if (needsReason(to) && pending !== to) {
      setPending(to);
      setError(null);
      return;
    }
    if (needsReason(to) && reason.trim().length < 3) {
      setError('Give the student a reason (at least 3 characters).');
      return;
    }
    transition.mutate(
      { orderId: order.data.id, to, reason: needsReason(to) ? reason.trim() : undefined },
      {
        onSuccess: () => {
          toast.show({ tone: 'success', title: `${order.data.pickupCode}: ${statusLabels[to]}` });
          reset();
        },
        onError: (e) => setError(describeError(e)),
      },
    );
  }

  function recordPayment() {
    if (!order.data) return;
    if (pending !== 'PAYMENT') {
      setPending('PAYMENT');
      setError(null);
      return;
    }
    payment.mutate(
      { orderId: order.data.id, amountPaise: order.data.totalPaise },
      {
        onSuccess: () => {
          toast.show({ tone: 'success', title: `Payment recorded for ${order.data.pickupCode}` });
          reset();
        },
        onError: (e) => setError(describeError(e)),
      },
    );
  }

  const o = order.data;
  const busy = transition.isPending || payment.isPending;

  return (
    <Dialog open={orderId !== null} onClose={close} title={o ? `Order ${o.pickupCode}` : 'Order'}>
      {order.isPending ? (
        <Spinner />
      ) : order.error ? (
        <ErrorState error={order.error} onRetry={() => void order.refetch()} />
      ) : o ? (
        <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                o.status === 'REJECTED' || o.status === 'CANCELLED' || o.status === 'NO_SHOW'
                  ? 'chili'
                  : 'dark'
              }
            >
              {statusLabels[o.status]}
            </Badge>
            <PaymentBadge order={o} />
          </div>
          <p className="text-sm text-espresso-500">
            For <strong className="text-espresso-900">{o.customer.displayName}</strong> · placed{' '}
            {formatDateTime(o.placedAt)}
          </p>

          <div>
            {o.items.map((item) => (
              <div key={item.menuItemId}>
                <TicketLine
                  label={`${item.quantity} × ${item.name}`}
                  value={formatINR(item.lineTotalPaise)}
                />
                {o.timing === 'SCHEDULED' && (
                  <div className="-mt-1 mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <FulfillmentChip type={item.fulfillmentType} />
                    {item.unsuitableForResale ? (
                      <span className="text-chili-700">Not resellable — won’t be restocked</span>
                    ) : (
                      item.fulfillmentType === 'PACKAGED' &&
                      ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status) && (
                        <button
                          type="button"
                          className="font-semibold text-espresso-700 underline hover:text-espresso-900"
                          onClick={() => {
                            setFlagReason('');
                            setFlagging({ menuItemId: item.menuItemId, name: item.name });
                          }}
                        >
                          Mark not resellable
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
            {o.timing === 'SCHEDULED' && o.scheduledFor && (
              <TicketLine label="Scheduled pickup" value={formatSlot(o.scheduledFor)} />
            )}
            <OrderTotals order={o} />
          </div>
          <PickupDeadline order={o} audience="staff" nowMs={nowMs} />
          <NoShowOutcome order={o} audience="staff" />
          {flagging && (
            <div className="flex flex-col gap-2 rounded-(--radius-control) border border-espresso-100 p-3">
              <TextField
                label={`Why can’t ${flagging.name} be resold?`}
                placeholder="e.g. Packet opened, damaged, expired"
                value={flagReason}
                maxLength={200}
                onChange={(event) => setFlagReason(event.target.value)}
              />
              {notResellable.error ? (
                <p role="alert" className="text-sm text-chili-600">
                  {describeError(notResellable.error)}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={flagReason.trim().length < 3}
                  loading={notResellable.isPending}
                  onClick={() =>
                    notResellable.mutate(
                      { orderId: o.id, menuItemId: flagging.menuItemId, reason: flagReason.trim() },
                      { onSuccess: () => setFlagging(null) },
                    )
                  }
                >
                  Mark not resellable
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setFlagging(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {o.counterPayment && (
            <p className="text-sm text-espresso-700">
              {formatINR(o.counterPayment.amountPaise)} received at the counter by{' '}
              {o.counterPayment.recordedBy}, {formatDateTime(o.counterPayment.recordedAt)}.
            </p>
          )}
          {o.cancelReason && (
            <p className="text-sm text-chili-700">Reason given: “{o.cancelReason}”</p>
          )}

          {pending && needsReason(pending as OrderStatus) && (
            <TextField
              label={`Reason for the student (${pending === 'REJECTED' ? 'rejecting' : 'cancelling'})`}
              value={reason}
              maxLength={200}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              hint={
                o.paymentStatus === 'PAID' && o.paymentMethod === 'GROUP'
                  ? 'Group order: each member’s share will be refunded to their wallet automatically.'
                  : o.paymentStatus === 'PAID' && o.paymentMethod === 'WALLET'
                    ? `${formatINR(o.refundPaise)} will be refunded to their wallet automatically.${feeKeptNote(o)}${pointsReturnNote(o)}`
                    : o.pointsRedeemed > 0
                      ? pointsReturnNote(o).trim()
                      : undefined
              }
            />
          )}
          {pending === 'PAYMENT' && (
            <p
              role="status"
              className="rounded-(--radius-control) bg-mustard-50 p-3 text-sm text-mustard-800"
            >
              Only confirm once you have actually received{' '}
              <strong>{formatINR(o.totalPaise)}</strong> from the student.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-chili-600">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {o.canRecordPayment && (
              <Button
                onClick={recordPayment}
                loading={payment.isPending}
                disabled={busy && !payment.isPending}
                icon={<Banknote className="size-4" aria-hidden />}
              >
                {pending === 'PAYMENT'
                  ? `Confirm ${formatINR(o.totalPaise)} received`
                  : 'Record counter payment'}
              </Button>
            )}
            {o.allowedNextStatuses.map((to) => {
              return (
                <Button
                  key={to}
                  variant={
                    needsReason(to) ? 'danger' : o.canRecordPayment ? 'secondary' : 'primary'
                  }
                  onClick={() => move(to)}
                  loading={transition.isPending && transition.variables?.to === to}
                  disabled={busy && transition.variables?.to !== to}
                >
                  {pending === to ? `Confirm: ${actionLabels[to]}` : actionLabels[to]}
                </Button>
              );
            })}
            {pending && (
              <Button variant="ghost" onClick={reset} disabled={busy}>
                Back
              </Button>
            )}
          </div>

          {o.status === 'READY' && (
            <div className="flex flex-col gap-2 rounded-(--radius-control) bg-cream-200 p-3 text-sm">
              <p>
                To hand this order over, ask the student for their pickup code (QR or 6 digits) and
                verify it.
                {o.paymentStatus !== 'PAID' && ' Record the counter payment first.'}
              </p>
              {onVerifyPickup && (
                <Button
                  size="sm"
                  className="self-start"
                  icon={<QrCode className="size-4" aria-hidden />}
                  onClick={() => {
                    onClose();
                    onVerifyPickup();
                  }}
                >
                  Verify pickup
                </Button>
              )}
            </div>
          )}

          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-espresso-700">
              Status history
            </summary>
            <ol className="mt-2 flex flex-col gap-1 text-espresso-500">
              {o.statusHistory.map((h, index) => (
                <li key={index}>
                  {formatDateTime(h.at)} — {statusLabels[h.toStatus].split(' — ')[0]}
                  {h.reason && ` (“${h.reason}”)`}
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}
    </Dialog>
  );
}
