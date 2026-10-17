import { Link } from 'react-router';
import { AlertTriangle, ShoppingBag } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Price } from '@/components/ui/Price';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { useCart, useClearCart, useRemoveFromCart, useSetQuantity } from '@/services/cart';
import { QuantityStepper } from './QuantityStepper';

export function CartPage() {
  const cart = useCart();
  const setQuantity = useSetQuantity();
  const remove = useRemoveFromCart();
  const clear = useClearCart();
  const toast = useToast();
  const onError = (error: unknown) =>
    toast.show({
      tone: 'error',
      title: 'Couldn’t update your cart',
      description: describeError(error),
    });

  if (cart.isPending) {
    return (
      <div aria-busy className="flex flex-col gap-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (cart.error) {
    return (
      <ErrorState
        error={cart.error}
        onRetry={() => void cart.refetch()}
        retrying={cart.isFetching}
      />
    );
  }

  const data = cart.data;
  if (!data.outlet || data.items.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Checkout" title="Your cart" />
        <EmptyState
          icon={<ShoppingBag aria-hidden />}
          title="Your cart is empty"
          description="Add something from an outlet’s menu to get started."
          action={<ButtonLink to="/">Browse outlets</ButtonLink>}
        />
      </>
    );
  }

  const busy = setQuantity.isPending || remove.isPending || clear.isPending;

  return (
    <>
      <PageHeader
        eyebrow="Checkout"
        title="Your cart"
        description={
          <>
            From{' '}
            <Link
              to={`/outlets/${data.outlet.slug}`}
              className="font-semibold text-chili-600 underline-offset-4 hover:underline"
            >
              {data.outlet.name}
            </Link>
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clear.mutate(undefined, { onError })}
            loading={clear.isPending}
          >
            Clear cart
          </Button>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="flex flex-col gap-4">
          {data.issues.length > 0 && (
            <div
              role="alert"
              className="flex gap-3 rounded-(--radius-control) border border-chili-100 bg-chili-50 p-4 text-sm text-chili-700"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p>Some items can’t be ordered as they are:</p>
                <ul className="mt-1 list-disc pl-5">
                  {data.issues.map((issue) => (
                    <li key={issue.menuItemId}>
                      <strong>{issue.name}</strong>:{' '}
                      {issue.reason === 'NOT_ENOUGH_STOCK'
                        ? `only ${issue.available ?? 0} left — lower the quantity to continue.`
                        : issue.reason === 'SOLD_OUT'
                          ? 'sold out — remove it to continue.'
                          : 'no longer on the menu — remove it to continue.'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {!data.outlet.acceptingOrders && (
            <div
              role="alert"
              className="flex gap-3 rounded-(--radius-control) border border-espresso-100 bg-cream-200 p-4 text-sm text-espresso-700"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>
                {data.canSchedule
                  ? `${data.outlet.name} isn’t taking orders right now. You can still schedule this order for a later pickup time.`
                  : `${data.outlet.name} isn’t taking orders right now, so this cart can’t be checked out yet.`}
              </p>
            </div>
          )}

          <Panel>
            <ul aria-label="Cart items">
              {data.items.map((item) => (
                <li
                  key={item.menuItemId}
                  className={cn(
                    'flex flex-wrap items-center gap-3 border-b border-dashed border-espresso-100 p-4 last:border-b-0',
                    !item.isOrderable && 'bg-chili-50/50',
                  )}
                >
                  {item.dietary && <DietaryMark dietary={item.dietary} />}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{item.name}</p>
                    <p className="text-sm text-espresso-500">
                      <Price paise={item.unitPricePaise} className="font-normal" /> each
                      {!item.isOrderable && (
                        <span className="ml-2 font-semibold text-chili-600">Unavailable</span>
                      )}
                    </p>
                  </div>
                  <QuantityStepper
                    name={item.name}
                    quantity={item.quantity}
                    busy={busy}
                    onChange={(quantity) =>
                      setQuantity.mutate({ menuItemId: item.menuItemId, quantity }, { onError })
                    }
                    onRemove={() => remove.mutate(item.menuItemId, { onError })}
                  />
                  <Price paise={item.lineTotalPaise} className="w-20 text-right" />
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel className="flex h-fit flex-col gap-4 p-5 lg:sticky lg:top-24">
          <h2 className="text-lg font-bold">Summary</h2>
          <dl className="flex flex-col gap-2">
            <div className="flex justify-between text-espresso-700">
              <dt>Items ({data.itemCount})</dt>
              <dd>
                <Price paise={data.subtotalPaise} className="font-normal" />
              </dd>
            </div>
            <div className="flex justify-between border-t border-espresso-100 pt-2 text-lg font-bold">
              <dt>Total</dt>
              <dd>
                <Price paise={data.totalPaise} />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-espresso-500">
            Prices are confirmed by the outlet’s menu when you place the order. No taxes are added;
            scheduling an order for later adds a fixed ₹10.
          </p>
          {data.canCheckout || data.canSchedule ? (
            <ButtonLink to="/checkout" size="lg" block>
              Continue to checkout
            </ButtonLink>
          ) : (
            <Button size="lg" block disabled>
              Continue to checkout
            </Button>
          )}
        </Panel>
      </div>
    </>
  );
}
