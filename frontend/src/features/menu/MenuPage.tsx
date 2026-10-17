import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SearchX, UtensilsCrossed } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { SelectField } from '@/components/ui/SelectField';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/cn';
import { isMenuSort } from '@/services/outlets';
import { useCampusMenu } from '@/services/menu';
import { MenuItemRow } from './MenuItemRow';
import { SortChips, SortNote } from './MenuControls';
import { chipClass, sortLabel } from './menu-labels';

/**
 * Every dish on campus: search by dish, category or outlet; filter by outlet, category, veg and
 * stock; sort by Popular, price, Quick Reorder or Highest Rated. All of it lives in the URL.
 */
export function MenuPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);
  const sortParam = params.get('sort');
  const sort = isMenuSort(sortParam) ? sortParam : undefined;
  const outletId = params.get('outlet') ?? undefined;
  const category = params.get('category') ?? undefined;
  const vegOnly = params.get('veg') === '1';
  const inStockOnly = params.get('stock') === '1';

  function update(changes: Record<string, string | undefined>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    update({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const menu = useCampusMenu({
    q: q || undefined,
    sort,
    outletId,
    category: outletId ? category : undefined,
    dietary: vegOnly ? 'VEG' : undefined,
    inStock: inStockOnly || undefined,
  });

  const first = menu.data?.pages[0];
  const items = menu.data?.pages.flatMap((p) => p.items) ?? [];
  const filtering = Boolean(q || outletId || category || vegOnly || inStockOnly);
  const clearFilters = () => {
    setSearch('');
    setParams(sort ? { sort } : {}, { replace: true });
  };
  const quick = first?.quickReorder;

  return (
    <>
      <PageHeader
        eyebrow="Campus menu"
        title="Find something to eat"
        description="Every dish from every open outlet — search, filter and sort it your way."
      />

      <div className="mb-6 flex flex-col gap-4">
        <SearchField
          label="Search dishes, categories or outlets"
          placeholder="Try “paneer”, “wraps” or an outlet"
          value={search}
          onChange={setSearch}
          className="max-w-xl"
        />
        <div className="grid gap-3 sm:grid-cols-2 md:max-w-xl">
          <SelectField
            label="Outlet"
            value={outletId ?? ''}
            onChange={(e) => update({ outlet: e.target.value || undefined, category: undefined })}
          >
            <option value="">All outlets</option>
            {first?.filters.outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Category"
            value={category ?? ''}
            disabled={!outletId}
            hint={!outletId ? 'Choose an outlet first' : undefined}
            onChange={(e) => update({ category: e.target.value || undefined })}
          >
            <option value="">All categories</option>
            {first?.filters.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        </div>
        <div role="group" aria-label="Menu filters" className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={vegOnly}
            className={chipClass(vegOnly)}
            onClick={() => update({ veg: vegOnly ? undefined : '1' })}
          >
            <DietaryMark dietary="VEG" decorative className={vegOnly ? 'bg-cream-50' : ''} />
            Veg only
          </button>
          <button
            type="button"
            aria-pressed={inStockOnly}
            className={chipClass(inStockOnly)}
            onClick={() => update({ stock: inStockOnly ? undefined : '1' })}
          >
            In stock only
          </button>
        </div>
        <SortChips value={sort} onChange={(next) => update({ sort: next })} />
        {first && (
          <p className="text-sm text-espresso-500" aria-live="polite">
            {first.total === 0
              ? 'No dishes'
              : `Showing ${items.length} of ${first.total} ${first.total === 1 ? 'dish' : 'dishes'}`}
            {sort && ` · sorted by ${sortLabel(sort)}`}
          </p>
        )}
        {sort === 'quick-reorder' && quick && !quick.signedIn && (
          <SortNote>
            <Link
              to={`/login?returnTo=${encodeURIComponent('/menu?sort=quick-reorder')}`}
              className="font-semibold underline"
            >
              Sign in
            </Link>{' '}
            to see the dishes you’ve ordered before first. Showing the usual order.
          </SortNote>
        )}
        {sort === 'quick-reorder' && quick?.signedIn && !quick.hasHistory && (
          <SortNote>
            You haven’t collected any of these dishes in the last {quick.windowDays} days, so
            they’re in the usual order.
          </SortNote>
        )}
      </div>

      {menu.isPending ? (
        <div aria-busy className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-20 w-full" />
          ))}
        </div>
      ) : menu.error ? (
        <ErrorState
          title="Couldn’t load the menu"
          error={menu.error}
          onRetry={() => void menu.refetch()}
          retrying={menu.isFetching}
        />
      ) : items.length === 0 ? (
        filtering ? (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title={q ? `Nothing matches “${q}”` : 'No dishes match these filters'}
            description="Try another word, or clear the filters."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<UtensilsCrossed aria-hidden />}
            title="No dishes yet"
            description="Outlets haven’t added their menus yet."
          />
        )
      ) : (
        <>
          <ol
            aria-label={sort ? `Dishes sorted by ${sortLabel(sort)}` : 'Dishes'}
            aria-busy={menu.isFetching}
            className={cn('max-w-3xl', menu.isFetching && !menu.isFetchingNextPage && 'opacity-70')}
          >
            {items.map((item) => (
              <MenuItemRow
                key={item.id}
                item={item}
                outlet={item.outlet!}
                showOutlet
                popularWindowDays={first?.popularWindowDays}
              />
            ))}
          </ol>
          {menu.hasNextPage && (
            <Button
              variant="secondary"
              className="mt-4"
              loading={menu.isFetchingNextPage}
              onClick={() => void menu.fetchNextPage()}
            >
              Show more dishes
            </Button>
          )}
        </>
      )}
    </>
  );
}
