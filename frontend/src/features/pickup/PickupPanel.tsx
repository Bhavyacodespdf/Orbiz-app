import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CircleCheck, Clock, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/feedback/Skeleton';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import type { Order } from '@/services/orders';
import { useOrderPickup, useRefreshPickup } from '@/services/pickup';

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/** The QR is drawn in the browser from the opaque payload the server issued. */
function QrImage({ payload, orderNumber }: { payload: string; orderNumber: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then(
      (out) => live && setSvg(out),
    );
    return () => {
      live = false;
    };
  }, [payload]);
  if (!svg) return <Skeleton className="size-48" />;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={`Pickup QR code for order ${orderNumber}`}
      className="size-48 rounded-(--radius-control) bg-white p-2"
    />
  );
}

/** "480 213" — easier to read aloud; the input accepts it with or without the space. */
const spaced = (code: string) => code.replace(/(\d{3})(?=\d)/g, '$1 ');

/**
 * The student's pickup credential on the order page: shown only while the order is READY and the
 * credential is active; "collected" afterwards, never a usable code again.
 */
export function PickupPanel({ order }: { order: Order }) {
  const pickup = useOrderPickup(order.id, order.status);
  const refresh = useRefreshPickup(order.id);
  const toast = useToast();

  if (pickup.isPending) return <Skeleton className="h-24 w-full" />;
  if (pickup.error || !pickup.data) return null;
  const p = pickup.data;
  if (p.state === 'ENDED') return null;

  const getNewCode = (
    <Button
      variant="secondary"
      size="sm"
      loading={refresh.isPending}
      icon={<RefreshCw className="size-3.5" aria-hidden />}
      onClick={() =>
        refresh.mutate(undefined, {
          onError: (e) =>
            toast.show({
              tone: 'error',
              title: 'Couldn’t get a new code',
              description: describeError(e),
            }),
        })
      }
    >
      Get a new code
    </Button>
  );

  return (
    <section
      aria-labelledby="pickup-heading"
      className="flex flex-col gap-3 rounded-(--radius-panel) border border-espresso-100 bg-cream-50 p-4"
    >
      {p.state === 'NOT_READY' && (
        <>
          <h2 id="pickup-heading" className="text-lg font-bold">
            Pickup code
          </h2>
          <p className="flex items-start gap-2 text-espresso-700">
            <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
            Your pickup code will appear here when your order is ready.
          </p>
        </>
      )}

      {p.state === 'ACTIVE' && (
        <>
          <h2 id="pickup-heading" className="text-lg font-bold text-success-700">
            Ready for pickup
          </h2>
          <p className="text-sm text-espresso-700">
            Order <strong>{order.pickupCode}</strong> at <strong>{order.outlet.name}</strong>. Show
            this code to the serving staff when collecting your order.
          </p>
          <div className="flex flex-col items-center gap-3">
            <QrImage payload={p.qrPayload} orderNumber={order.pickupCode} />
            <div className="text-center">
              <p className="text-xs font-bold tracking-[0.18em] text-espresso-500 uppercase">
                Pickup code
              </p>
              <p
                className="font-display text-4xl font-extrabold tracking-[0.12em] tabular"
                aria-label={`Pickup code ${[...p.code].join(' ')}`}
              >
                {spaced(p.code)}
              </p>
            </div>
          </div>
          {p.paymentDuePaise > 0 && (
            <p className="rounded-(--radius-control) bg-mustard-50 p-2 text-sm text-mustard-800">
              Pay {formatINR(p.paymentDuePaise)} at the counter before the order can be handed over.
            </p>
          )}
          <p className="text-xs text-espresso-500">Valid until {clock(p.expiresAt)} today.</p>
          <p className="flex items-start gap-2 text-xs text-espresso-700">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Don’t share this code or screenshot — anyone holding it could collect your order. If you
            think someone saw it, get a new one.
          </p>
          <div>{getNewCode}</div>
        </>
      )}

      {p.state === 'EXPIRED' && (
        <>
          <h2 id="pickup-heading" className="text-lg font-bold">
            Your pickup code expired
          </h2>
          <p className="text-sm text-espresso-700">
            Your order is still ready. Get a new code to collect it.
          </p>
          <div>{getNewCode}</div>
        </>
      )}

      {p.state === 'COLLECTED' && (
        <>
          <h2
            id="pickup-heading"
            className="flex items-center gap-2 text-lg font-extrabold tracking-wide text-success-700 uppercase"
          >
            <CircleCheck className="size-5" aria-hidden />
            Order collected
          </h2>
          <p className="text-sm text-espresso-700">
            Handed over at {clock(p.collectedAt)}. Enjoy your food!
          </p>
        </>
      )}
    </section>
  );
}
