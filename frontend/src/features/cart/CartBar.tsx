import { Link } from 'react-router';
import { ShoppingBag } from 'lucide-react';
import { formatINR } from '@/lib/money';
import { useCart } from '@/services/cart';

/** Floating summary of the server cart, shown while browsing that outlet's menu. */
export function CartBar({ outletId }: { outletId: string }) {
  const { data: cart } = useCart();
  if (!cart || cart.itemCount === 0 || cart.outlet?.id !== outletId) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 lg:bottom-6">
      <Link
        to="/cart"
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-espresso-900 py-3 pr-5 pl-3 text-cream-100 shadow-lift transition-transform hover:-translate-y-0.5"
      >
        <span className="grid size-9 place-items-center rounded-full bg-mustard-500 text-espresso-900">
          <ShoppingBag className="size-4" aria-hidden />
        </span>
        <span className="flex-1 font-semibold">
          {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'} ·{' '}
          <span className="tabular">{formatINR(cart.totalPaise)}</span>
        </span>
        <span className="font-bold text-mustard-300">View cart →</span>
      </Link>
    </div>
  );
}
