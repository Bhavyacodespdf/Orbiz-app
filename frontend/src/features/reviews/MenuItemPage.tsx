import { Link, useParams } from 'react-router';
import { ArrowLeft, UtensilsCrossed } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Price } from '@/components/ui/Price';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { ApiError } from '@/services/http';
import { useCurrentUser } from '@/services/auth';
import { useMenuItem } from '@/services/reviews';
import { AddToCartControl } from '@/features/cart/AddToCartControl';
import { StockBadge } from '@/features/inventory/StockBadge';
import { RatingInline } from './Stars';
import { RatingBreakdown, ReviewList, YourReview } from './ReviewSection';

/** A dish: what it is, its real rating breakdown, the student's own review and everyone's. */
export function MenuItemPage() {
  const { slug = '', itemId = '' } = useParams();
  const detail = useMenuItem(itemId);
  const { data: user } = useCurrentUser();

  if (detail.isPending) {
    return (
      <div aria-busy className="flex flex-col gap-4">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (detail.error) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <EmptyState
          icon={<UtensilsCrossed aria-hidden />}
          title="Dish not found"
          description="It may have been taken off the menu."
          action={<ButtonLink to={slug ? `/outlets/${slug}` : '/'}>Back to the menu</ButtonLink>}
        />
      );
    }
    return (
      <ErrorState
        title="Couldn’t load this dish"
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
      />
    );
  }

  const { item, outlet, category } = detail.data;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link
        to={`/outlets/${outlet.slug}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-espresso-500 hover:text-espresso-900"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {outlet.name} menu
      </Link>

      <header className="flex flex-col gap-2">
        <p className="text-sm font-bold tracking-[0.14em] text-espresso-500 uppercase">
          {category.name}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {item.dietary && <DietaryMark dietary={item.dietary} />}
          <h1 className="text-3xl font-extrabold md:text-4xl">{item.name}</h1>
        </div>
        <RatingInline rating={item.rating} />
        {item.description && <p className="text-espresso-700">{item.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <Price paise={item.pricePaise} className="text-xl" />
          {item.stockStatus !== 'AVAILABLE' && <StockBadge status={item.stockStatus} />}
          <AddToCartControl item={item} outlet={outlet} />
        </div>
      </header>

      <RatingBreakdown rating={item.rating} />
      <YourReview itemId={item.id} itemName={item.name} />
      <ReviewList itemId={item.id} canReport={Boolean(user?.roles.includes('STUDENT'))} />
    </div>
  );
}
