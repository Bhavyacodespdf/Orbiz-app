import { Link } from 'react-router';
import { Flame, History } from 'lucide-react';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Price } from '@/components/ui/Price';
import { cn } from '@/lib/cn';
import type { Outlet, RankedItem } from '@/services/outlets';
import { AddToCartControl } from '@/features/cart/AddToCartControl';
import { StockBadge } from '@/features/inventory/StockBadge';
import { RatingInline } from '@/features/reviews/Stars';
import { itemPath } from '@/features/reviews/review-labels';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** One dish on a menu: name, price, rating, stock and what the chosen sort was based on. */
export function MenuItemRow({
  item,
  outlet,
  showOutlet = false,
  popularWindowDays,
}: {
  item: RankedItem;
  outlet: Outlet;
  /** Campus menu: say which outlet serves it. */
  showOutlet?: boolean;
  popularWindowDays?: number | null;
}) {
  return (
    <li className="flex gap-3 border-b border-dashed border-espresso-100 py-4 last:border-b-0">
      {item.dietary ? (
        <DietaryMark dietary={item.dietary} className="mt-1" />
      ) : (
        <span className="w-4" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3
            className={cn(
              'font-sans text-base font-semibold',
              item.isAvailable ? 'text-espresso-900' : 'text-espresso-500',
            )}
          >
            <Link to={itemPath(outlet.slug, item.id)} className="hover:underline">
              {item.name}
            </Link>
          </h3>
          <span
            className="mb-1 hidden flex-1 border-b border-dotted border-espresso-200 sm:block"
            aria-hidden
          />
          <Price
            paise={item.pricePaise}
            className={cn(
              'ml-auto shrink-0 sm:ml-0',
              item.isAvailable ? 'text-espresso-900' : 'text-espresso-500 line-through',
            )}
          />
        </div>
        {showOutlet && (
          <p className="text-sm text-espresso-700">
            {outlet.name}
            {item.category && <span className="text-espresso-500"> · {item.category.name}</span>}
          </p>
        )}
        {item.description && <p className="mt-0.5 text-sm text-espresso-500">{item.description}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <RatingInline rating={item.rating} to={itemPath(outlet.slug, item.id)} />
          {item.popular && item.orders30d !== null && (
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-chili-700">
              <Flame className="size-3.5" aria-hidden />
              Popular · {item.orders30d} orders in {popularWindowDays ?? 30} days
            </span>
          )}
          {item.mine && (
            <span className="inline-flex items-center gap-1 text-sm text-espresso-700">
              <History className="size-3.5" aria-hidden />
              You’ve ordered this {item.mine.orders === 1 ? 'once' : `${item.mine.orders} times`} ·
              last {shortDate(item.mine.lastOrderedAt)}
            </span>
          )}
        </div>
        {item.stockStatus !== 'AVAILABLE' && (
          <StockBadge status={item.stockStatus} className="mt-2" />
        )}
      </div>
      <div className="flex shrink-0 items-start pt-0.5">
        <AddToCartControl item={item} outlet={outlet} />
      </div>
    </li>
  );
}
