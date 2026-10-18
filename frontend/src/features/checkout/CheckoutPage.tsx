import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AlertTriangle, ShoppingBag, Sparkles, Store, WalletMinimal } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Price } from '@/components/ui/Price';
import { TextField } from '@/components/ui/TextField';
import { Ticket, TicketLine } from '@/components/ui/Ticket';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { EmptyState } from '@/components/feedback/EmptyState';
import { describeError } from '@/lib/errors';
import { newIdempotencyKey } from '@/lib/idempotency';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/cn';
import { ApiError } from '@/services/http';
import { useCart } from '@/services/cart';
import { useWallet } from '@/services/wallet';
import { usePlaceOrder } from '@/services/orders';
import { useSlots } from '@/services/scheduling';
import { SlotPicker } from '@/features/scheduling/SlotPicker';
import { formatSlot, formatClock } from '@/features/scheduling/schedule-format';

type Method = 'WALLET' | 'COUNTER';

function MethodOption({
  value,
  selected,
  disabled = false,
  onSelect,
  icon,
  title,
  children,
}: {
  value: Method;
  selected: boolean;
  disabled?: boolean;
  onSelect: (value: Method) => void;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-(--radius-control) border-2 p-4 transition-colors',
        selected
          ? 'border-chili-500 bg-chili-50/60'
          : 'border-espresso-100 bg-cream-50 hover:border-espresso-200',
        disabled && 'cursor-not-allowed border-dashed bg-cream-200',
      )}
    >
      <input
        type="radio"
        name="payment-method"
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="mt-1 size-4 accent-chili-500"
      />
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-espresso-900 text-mustard-500">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-espresso-500">{children}</span>
      </span>
    </label>
  );
}

const pointsLabel = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;

/**
 * Lets the student spend loyalty points (1 point = ₹1). The limits shown come from
 * the server; the server re-checks both the order and the balance when placing it.
 */
function PointsRedemption({
  available,
  max,
  pointValuePaise,
  value,
  error,
  onChange,
}: {
  available: number;
  max: number;
  pointValuePaise: number;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  if (available === 0) return null;
  return (
    <section
      aria-labelledby="points-heading"
      className="flex flex-col gap-3 rounded-(--radius-control) border border-mustard-100 bg-mustard-50 p-4"
    >
      <h2 id="points-heading" className="flex items-center gap-2 font-semibold">
        <Sparkles className="size-4 text-mustard-700" aria-hidden />
        Use loyalty points
      </h2>
      <p className="text-sm text-espresso-700">
        You have <strong>{pointsLabel(available)}</strong> (worth{' '}
        {formatINR(available * pointValuePaise)}). 1 point = {formatINR(pointValuePaise)} off.{' '}
        {max === 0
          ? 'They can’t be used on this order: at least ₹1 must be paid with money.'
          : `You can use up to ${pointsLabel(max)} on this order.`}
      </p>
      {max > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label="Points to use"
            inputMode="numeric"
            placeholder="0"
            value={value}
            error={error ?? undefined}
            onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            className="w-40"
          />
          <Button variant="secondary" size="md" onClick={() => onChange(String(max))}>
            Use {pointsLabel(max)}
          </Button>
          {value !== '' && value !== '0' && (
            <Button variant="ghost" size="md" onClick={() => onChange('')}>
              Don’t use points
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function CheckoutPage() {
  const navigate = useNavigate();
  const cart = useCart();
  const wallet = useWallet();
  const placeOrder = usePlaceOrder();
  const [method, setMethod] = useState<Method>('WALLET');
  const [timing, setTiming] = useState<'NOW' | 'LATER'>('NOW');
  const [slot, setSlot] = useState<string | null>(null);
  // Captured once per visit; the slot list itself refreshes from the server.
  const [nowMs] = useState(() => Date.now());
  const slots = useSlots(cart.data?.outlet?.slug, Boolean(cart.data?.canSchedule));
  const [notice, setNotice] = useState<string | null>(null);
  const [pointsInput, setPointsInput] = useState('');
  // One key for this checkout. Retries reuse it, so the server can never create two orders.
  const idempotencyKey = useRef(newIdempotencyKey());
  // Outlet at capacity: placing is paused until the server says room opens up.
  const [capacityRetryAt, setCapacityRetryAt] = useState<number | null>(null);
  useEffect(() => {
    if (capacityRetryAt === null) return;
    const timer = window.setTimeout(
      () => {
        setCapacityRetryAt(null);
        setNotice(null);
      },
      Math.max(0, capacityRetryAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [capacityRetryAt]);

  if (cart.isPending || wallet.isPending) {
    return <Skeleton className="h-80 w-full" />;
  }
  if (cart.error || wallet.error) {
    const error = cart.error ?? wallet.error;
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          void cart.refetch();
          void wallet.refetch();
        }}
      />
    );
  }
  const data = cart.data;
  if (!data.outlet || data.items.length === 0) {
    if (placeOrder.isSuccess) return null; // navigating to the confirmation
    return (
      <EmptyState
        icon={<ShoppingBag aria-hidden />}
        title="Nothing to check out"
        description="Your cart is empty."
        action={<ButtonLink to="/">Browse outlets</ButtonLink>}
      />
    );
  }
  if (!data.canCheckout && !data.canSchedule) return <Navigate to="/cart" replace />;
  // Closed right now: only a later pickup slot is possible.
  const scheduling = timing === 'LATER' || !data.canCheckout;

  const { availablePoints, maxRedeemablePoints, pointValuePaise } = data.loyalty;
  const requestedPoints = pointsInput === '' ? 0 : Number(pointsInput);
  const pointsError =
    requestedPoints > maxRedeemablePoints
      ? `You can use at most ${pointsLabel(maxRedeemablePoints)} on this order.`
      : null;
  const pointsToRedeem = pointsError ? 0 : requestedPoints;
  const discountPaise = pointsToRedeem * pointValuePaise;
  // The fee comes from the server's slot list; the server adds it again itself.
  const feePaise = scheduling ? (slots.data?.feePaise ?? 0) : 0;
  // Display only: the server recalculates and must agree, or the order is refused.
  const payablePaise = data.totalPaise - discountPaise + feePaise;
  const needsSlot = scheduling && !slot;

  const balance = wallet.data.balancePaise;
  const shortfall = Math.max(0, payablePaise - balance);
  const walletEnough = shortfall === 0;
  const effectiveMethod: Method = method === 'WALLET' && !walletEnough ? 'COUNTER' : method;
  const topUpPaise = Math.max(shortfall, wallet.data.recharge.minPaise);

  function submit() {
    setNotice(null);
    placeOrder.mutate(
      {
        paymentMethod: effectiveMethod,
        expectedTotalPaise: payablePaise,
        pointsToRedeem,
        ...(scheduling && slot && { scheduledFor: slot }),
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: (order) => navigate(`/orders/${order.id}`, { replace: true }),
        onError: (error) => {
          if (error instanceof ApiError) {
            if (error.code === 'ORDER_CAPACITY_FULL') {
              // Nothing was ordered or charged and the cart is untouched; the same key is reused.
              const retryAt = (error.details as { retryAt?: string } | undefined)?.retryAt;
              const retryMs = retryAt ? Date.parse(retryAt) : NaN;
              setNotice(
                Number.isNaN(retryMs)
                  ? error.message
                  : `${error.message} You can try again from ${formatClock(retryAt!)}.`,
              );
              setCapacityRetryAt(Number.isNaN(retryMs) ? Date.now() + 30_000 : retryMs);
              return;
            }
            if (error.code === 'PRICE_CHANGED') {
              const total = (error.details as { totalPaise?: number })?.totalPaise;
              setNotice(
                `Prices changed since you opened checkout${total ? ` — the new total is ${formatINR(total)}` : ''}. Please review and place your order again.`,
              );
              void cart.refetch();
              return;
            }
            if (
              [
                'SLOT_IN_PAST',
                'SLOT_TOO_SOON',
                'SLOT_TOO_FAR',
                'SLOT_FULL',
                'INVALID_SLOT',
                'SCHEDULING_UNAVAILABLE',
              ].includes(error.code)
            ) {
              setNotice(`${error.message} Please choose another pickup time.`);
              setSlot(null);
              void slots.refetch();
              return;
            }
            if (error.code === 'INSUFFICIENT_POINTS' || error.code === 'POINTS_EXCEED_ORDER') {
              setNotice(
                `${error.message} Your points have been refreshed — please check and try again.`,
              );
              setPointsInput('');
              void cart.refetch();
              void wallet.refetch();
              return;
            }
            if (error.code === 'INSUFFICIENT_BALANCE') {
              setNotice('Your wallet balance changed and is now too low for this order.');
              void wallet.refetch();
              return;
            }
            if (
              [
                'ITEMS_UNAVAILABLE',
                'INSUFFICIENT_STOCK',
                'OUTLET_NOT_ACCEPTING',
                'CART_EMPTY',
              ].includes(error.code)
            ) {
              setNotice(error.message);
              void cart.refetch();
              return;
            }
          }
          setNotice(describeError(error));
        },
      },
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Checkout"
        title="Place your order"
        description={`Pick up from ${data.outlet.name}.`}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <section aria-labelledby="pay-heading" className="flex flex-col gap-4">
          <h2 id="pay-heading" className="text-xl font-bold">
            How would you like to pay?
          </h2>
          <div role="radiogroup" aria-labelledby="pay-heading" className="flex flex-col gap-3">
            <MethodOption
              value="WALLET"
              selected={effectiveMethod === 'WALLET'}
              disabled={!walletEnough}
              onSelect={setMethod}
              icon={<WalletMinimal className="size-5" aria-hidden />}
              title="Orbiz wallet"
            >
              Balance{' '}
              <span className="tabular font-semibold text-espresso-900">{formatINR(balance)}</span>{' '}
              (simulated test funds).{' '}
              {walletEnough ? (
                'Paid instantly.'
              ) : (
                <>
                  You need <strong className="tabular">{formatINR(shortfall)}</strong> more.
                </>
              )}
            </MethodOption>
            <MethodOption
              value="COUNTER"
              selected={effectiveMethod === 'COUNTER'}
              onSelect={setMethod}
              icon={<Store className="size-5" aria-hidden />}
              title="Pay at the counter"
            >
              Pay when you collect. Your order is marked paid only after the cashier records your
              payment.
            </MethodOption>
          </div>

          <section aria-labelledby="timing-heading" className="flex flex-col gap-3">
            <h2 id="timing-heading" className="text-xl font-bold">
              When do you want it?
            </h2>
            {!data.canCheckout && (
              <p className="rounded-(--radius-control) bg-cream-200 px-3 py-2 text-sm text-espresso-700">
                {data.outlet.name} isn’t taking orders right now, but you can schedule one for a
                later pickup time.
              </p>
            )}
            <div
              role="radiogroup"
              aria-labelledby="timing-heading"
              className="grid gap-2 sm:grid-cols-2"
            >
              {(
                [
                  {
                    value: 'NOW',
                    title: 'Order now',
                    detail: 'Prepared as soon as the outlet accepts it.',
                  },
                  {
                    value: 'LATER',
                    title: 'Schedule for later',
                    detail: `Pick a pickup time. Adds ${formatINR(slots.data?.feePaise ?? 1_000)} per order.`,
                  },
                ] as const
              ).map((option) => {
                const disabled = option.value === 'NOW' ? !data.canCheckout : !data.canSchedule;
                const selected = (option.value === 'LATER') === scheduling;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer gap-3 rounded-(--radius-control) border-2 p-3 transition-colors',
                      selected
                        ? 'border-chili-500 bg-chili-50/60'
                        : 'border-espresso-100 bg-cream-50',
                      disabled && 'cursor-not-allowed border-dashed bg-cream-200 opacity-70',
                    )}
                  >
                    <input
                      type="radio"
                      name="timing"
                      className="mt-1 size-4 accent-chili-500"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => {
                        setTiming(option.value);
                        setNotice(null);
                      }}
                    />
                    <span>
                      <span className="block font-semibold">{option.title}</span>
                      <span className="block text-sm text-espresso-500">{option.detail}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {scheduling &&
              (slots.isPending ? (
                <p className="text-sm text-espresso-500">Loading pickup times…</p>
              ) : slots.error ? (
                <p role="alert" className="text-sm text-chili-700">
                  Couldn’t load pickup times. {describeError(slots.error)}
                </p>
              ) : (
                <SlotPicker options={slots.data} value={slot} onChange={setSlot} nowMs={nowMs} />
              ))}
          </section>

          <PointsRedemption
            available={availablePoints}
            max={maxRedeemablePoints}
            pointValuePaise={pointValuePaise}
            value={pointsInput}
            error={pointsError}
            onChange={(value) => {
              setPointsInput(value);
              setNotice(null);
            }}
          />

          {!walletEnough && wallet.data.recharge.available && (
            <ButtonLink
              to={`/wallet?amount=${Math.ceil(topUpPaise / 100)}&returnTo=${encodeURIComponent('/checkout')}`}
              variant="secondary"
              className="w-fit"
            >
              Add {formatINR(Math.ceil(topUpPaise / 100) * 100)} to wallet
            </ButtonLink>
          )}

          {notice && (
            <div
              role="alert"
              className="flex gap-3 rounded-(--radius-control) border border-chili-100 bg-chili-50 p-4 text-sm text-chili-700"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>{notice}</p>
            </div>
          )}
        </section>

        <div className="flex h-fit flex-col gap-5 lg:sticky lg:top-24">
          <Ticket
            header={
              <div className="flex items-center justify-between">
                <span className="font-display text-lg font-bold">{data.outlet.name}</span>
                <span className="text-sm text-espresso-500">
                  {data.itemCount} {data.itemCount === 1 ? 'item' : 'items'}
                </span>
              </div>
            }
          >
            {data.items.map((item) => (
              <TicketLine
                key={item.menuItemId}
                label={`${item.quantity} × ${item.name}`}
                value={formatINR(item.lineTotalPaise)}
              />
            ))}
            {(discountPaise > 0 || feePaise > 0) && (
              <TicketLine label="Food subtotal" value={formatINR(data.totalPaise)} />
            )}
            {discountPaise > 0 && (
              <TicketLine
                label={`Loyalty points (${pointsLabel(pointsToRedeem)})`}
                value={`−${formatINR(discountPaise)}`}
              />
            )}
            {feePaise > 0 && <TicketLine label="Scheduled-order fee" value={formatINR(feePaise)} />}
            {scheduling && slot && <TicketLine label="Pickup" value={formatSlot(slot)} />}
            <TicketLine
              label={discountPaise > 0 || feePaise > 0 ? 'To pay' : 'Total'}
              value={<Price paise={payablePaise} />}
              emphasis
            />
          </Ticket>
          <Button
            size="lg"
            block
            onClick={submit}
            loading={placeOrder.isPending}
            disabled={pointsError !== null || needsSlot || capacityRetryAt !== null}
          >
            {scheduling ? 'Schedule · ' : ''}
            {effectiveMethod === 'WALLET' ? 'Pay from wallet' : 'Place order'} ·{' '}
            {formatINR(payablePaise)}
          </Button>
        </div>
      </div>
    </>
  );
}
