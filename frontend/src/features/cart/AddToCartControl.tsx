import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { ApiError } from '@/services/http';
import { useCurrentUser } from '@/services/auth';
import { useAddToCart, useCart, useRemoveFromCart, useSetQuantity } from '@/services/cart';
import type { MenuItem, Outlet } from '@/services/outlets';
import { QuantityStepper } from './QuantityStepper';

interface Conflict {
  current: string;
  next: string;
}

/**
 * "Add" for one menu item, or a quantity stepper once it's in the cart.
 * Every change goes to the server, which returns the authoritative cart.
 */
export function AddToCartControl({
  item,
  outlet,
}: {
  item: Omit<MenuItem, 'rating'>;
  outlet: Outlet;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { data: user } = useCurrentUser();
  const cart = useCart();
  const add = useAddToCart();
  const setQuantity = useSetQuantity();
  const remove = useRemoveFromCart();
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const line =
    cart.data?.outlet?.id === outlet.id
      ? cart.data.items.find((i) => i.menuItemId === item.id)
      : undefined;
  const busy = add.isPending || setQuantity.isPending || remove.isPending;
  const onError = (error: unknown) =>
    toast.show({
      tone: 'error',
      title: 'Couldn’t update your cart',
      description: describeError(error),
    });

  if (!item.isAvailable || !outlet.acceptingOrders) return null;

  function addItem(replaceCart = false) {
    if (!user) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    add.mutate(
      { menuItemId: item.id, replaceCart },
      {
        onSuccess: () => setConflict(null),
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'CART_OUTLET_CONFLICT') {
            const details = error.details as {
              currentOutlet?: { name: string };
              newOutlet?: { name: string };
            };
            setConflict({
              current: details.currentOutlet?.name ?? 'another outlet',
              next: details.newOutlet?.name ?? outlet.name,
            });
            return;
          }
          setConflict(null);
          onError(error);
        },
      },
    );
  }

  return (
    <>
      {line ? (
        <QuantityStepper
          name={item.name}
          quantity={line.quantity}
          busy={busy}
          onChange={(quantity) =>
            setQuantity.mutate({ menuItemId: item.id, quantity }, { onError })
          }
          onRemove={() => remove.mutate(item.id, { onError })}
        />
      ) : (
        <Button
          size="sm"
          variant="secondary"
          loading={add.isPending}
          icon={<Plus className="size-4" aria-hidden />}
          onClick={() => addItem()}
          aria-label={`Add ${item.name} to cart`}
        >
          Add
        </Button>
      )}
      <ConfirmDialog
        open={conflict !== null}
        title="Start a new cart?"
        description={
          <p>
            Your cart has items from <strong>{conflict?.current}</strong>. A cart can only hold
            items from one outlet, so adding this will remove them and start a new cart from{' '}
            <strong>{conflict?.next}</strong>.
          </p>
        }
        confirmLabel="Start new cart"
        cancelLabel="Keep my cart"
        destructive
        loading={add.isPending}
        onCancel={() => setConflict(null)}
        onConfirm={() => addItem(true)}
      />
    </>
  );
}
