import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Clock, MapPin, SearchX, Store, UtensilsCrossed } from 'lucide-react';
import { StatusSign } from '@/components/ui/StatusSign';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/cn';
import { ApiError } from '@/services/http';
import { isMenuSort, useOutletMenu, type Outlet } from '@/services/outlets';
import { MenuItemRow } from './MenuItemRow';
import { SortChips, SortNote } from './MenuControls';
import { chipClass, sortLabel } from './menu-labels';
import { CartBar } from '@/features/cart/CartBar';
import { OutletSpecial } from '@/features/specials/Specials';
import { PollPanel } from '@/features/specials/PollPanel';

function OutletHeader({ outlet }: { outlet: Outlet }) {
  return (
    <header className="mb-6 flex flex-col gap-3">
      <Link
        to="/"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-espresso-500 hover:text-espresso-900"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All outlets
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-extrabold md:text-4xl">{outlet.name}</h1>
        <StatusSign status={outlet.status} />
        {outlet.isSample && <Badge tone="mustard">Sample data</Badge>}
      </div>
      {outlet.location && (
        <p className="flex items-center gap-1.5 text-espresso-500">
          <MapPin className="size-4 shrink-0" aria-hidden />
          {outlet.location}
        </p>
      )}
      {outlet.description && <p className="max-w-2xl text-espresso-700">{outlet.description}</p>}
      {!outlet.acceptingOrders && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-(--radius-control) border border-espresso-100 bg-cream-200 px-4 py-3 text-sm text-espresso-700"
        >
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
          {outlet.status === 'PAUSED'
            ? 'This outlet has paused new orders for now. You can still browse the menu.'
            : 'This outlet is closed right now. You can browse the menu, but it isn’t taking orders.'}
        </p>
      )}
    </header>
  );
}

export function OutletPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);
  const category = params.get('category') ?? undefined;
  const vegOnly = params.get('veg') === '1';
  const inStockOnly = params.get('stock') === '1';
  const sortParam = params.get('sort');
  // "rating" was the old name for Highest Rated (shared links keep working).
  const sort = isMenuSort(sortParam)
    ? sortParam
    : sortParam === 'rating'
      ? 'highest-rated'
      : undefined;

  // Filters live in the URL, so they survive refresh and can be shared.
  function updateParam(key: string, value: string | undefined) {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (value) nextParams.set(key, value);
        else nextParams.delete(key);
        return nextParams;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    updateParam('q', q || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const menu = useOutletMenu(slug, {
    q: q || undefined,
    category,
    dietary: vegOnly ? 'VEG' : undefined,
    sort,
    inStock: inStockOnly || undefined,
  });

  const sections = useMemo(() => {
    if (!menu.data) return [];
    return menu.data.categories
      .map((c) => ({ category: c, items: menu.data.items.filter((i) => i.categoryId === c.id) }))
      .filter((section) => section.items.length > 0);
  }, [menu.data]);

  if (menu.isPending) {
    return (
      <div aria-busy className="flex flex-col gap-4">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  }

  if (menu.error) {
    if (menu.error instanceof ApiError && menu.error.status === 404) {
      return (
        <EmptyState
          icon={<Store aria-hidden />}
          title="Outlet not found"
          description="It may have been renamed or is no longer listed."
          action={<ButtonLink to="/">See all outlets</ButtonLink>}
        />
      );
    }
    return (
      <ErrorState
        title="Couldn’t load this menu"
        error={menu.error}
        onRetry={() => void menu.refetch()}
        retrying={menu.isFetching}
      />
    );
  }

  const { outlet, categories } = menu.data;
  const filtering = Boolean(q || category || vegOnly || inStockOnly);
  // Clearing filters keeps the chosen sort.
  const clearFilters = () => {
    setSearch('');
    setParams(sort ? { sort } : {}, { replace: true });
  };
  const quick = menu.data.quickReorder;

  return (
    <>
      <OutletHeader outlet={outlet} />
      <CartBar outletId={outlet.id} />
      <OutletSpecial outlet={outlet} />
      <PollPanel slug={outlet.slug} />

      <div className="sticky top-16 z-20 -mx-4 mb-4 flex flex-col gap-3 bg-cream-100/95 px-4 py-3 backdrop-blur">
        <SearchField
          label={`Search the ${outlet.name} menu`}
          placeholder="Search dishes or categories"
          value={search}
          onChange={setSearch}
          className="max-w-xl"
        />
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
          role="group"
          aria-label="Menu filters"
        >
          <button
            type="button"
            aria-pressed={vegOnly}
            className={chipClass(vegOnly)}
            onClick={() => updateParam('veg', vegOnly ? undefined : '1')}
          >
            <DietaryMark dietary="VEG" decorative className={vegOnly ? 'bg-cream-50' : ''} />
            Veg only
          </button>
          <button
            type="button"
            aria-pressed={inStockOnly}
            className={chipClass(inStockOnly)}
            onClick={() => updateParam('stock', inStockOnly ? undefined : '1')}
          >
            In stock only
          </button>
          <span className="mx-1 w-px shrink-0 bg-espresso-100" aria-hidden />
          <button
            type="button"
            aria-pressed={!category}
            className={chipClass(!category)}
            onClick={() => updateParam('category', undefined)}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category === c.id}
              className={chipClass(category === c.id)}
              onClick={() => updateParam('category', category === c.id ? undefined : c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        <SortChips value={sort} onChange={(next) => updateParam('sort', next)} />
        <p className="text-sm text-espresso-500" aria-live="polite">
          {menu.data.items.length} {menu.data.items.length === 1 ? 'dish' : 'dishes'}
          {sort && ` · sorted by ${sortLabel(sort)}`}
        </p>
        {sort === 'quick-reorder' && quick && !quick.signedIn && (
          <SortNote>
            <Link
              to={`/login?returnTo=${encodeURIComponent(`/outlets/${outlet.slug}?sort=quick-reorder`)}`}
              className="font-semibold underline"
            >
              Sign in
            </Link>{' '}
            to see the dishes you’ve ordered before first. Showing the usual menu order.
          </SortNote>
        )}
        {sort === 'quick-reorder' && quick?.signedIn && !quick.hasHistory && (
          <SortNote>
            You haven’t collected any of these dishes in the last {quick.windowDays} days, so
            they’re in the usual order. Your previous meals also appear under Quick reorder on the
            home page.
          </SortNote>
        )}
      </div>

      {menu.data.items.length === 0 ? (
        filtering ? (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title="No dishes match these filters"
            description={q ? `Nothing on this menu matches “${q}”.` : undefined}
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<UtensilsCrossed aria-hidden />}
            title="No menu yet"
            description="This outlet hasn’t added any dishes yet."
          />
        )
      ) : sort ? (
        // A chosen sort ranks every matching dish in one list.
        <ol
          aria-label={`Dishes sorted by ${sortLabel(sort)}`}
          aria-busy={menu.isFetching}
          className={cn('max-w-3xl', menu.isFetching && 'opacity-70')}
        >
          {menu.data.items.map((item) => (
            <MenuItemRow
              key={item.id}
              item={item}
              outlet={outlet}
              popularWindowDays={menu.data.popularWindowDays}
            />
          ))}
        </ol>
      ) : (
        <div
          className={cn('grid gap-x-10 gap-y-6 lg:grid-cols-2', menu.isFetching && 'opacity-70')}
          aria-busy={menu.isFetching}
        >
          {sections.map(({ category: c, items }) => (
            <section key={c.id} aria-labelledby={`cat-${c.id}`}>
              <h2
                id={`cat-${c.id}`}
                className="border-b-2 border-espresso-900 pb-2 text-sm font-bold tracking-[0.14em] uppercase"
              >
                {c.name}
              </h2>
              <ul>
                {items.map((item) => (
                  <MenuItemRow key={item.id} item={item} outlet={outlet} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
