import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SearchX, Store } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchField } from '@/components/ui/SearchField';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useOutlets } from '@/services/outlets';
import { TodaysSpecials } from '@/features/specials/Specials';
import { SurpriseMealPromo } from '@/features/surprise/SurpriseMealPromo';
import { OutletCard } from './OutletCard';
import { ReorderSections } from '@/features/reorder/ReorderSections';

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);

  // Keep the search in the URL so it survives refresh and the back button.
  useEffect(() => {
    setParams(q ? { q } : {}, { replace: true });
  }, [q, setParams]);

  const outlets = useOutlets(q);

  return (
    <>
      <PageHeader
        eyebrow="Campus outlets"
        title="Hungry? Let’s get you fed."
        description="Browse what’s cooking across campus, order ahead, and pick up when it’s ready."
      />

      {!q && <ReorderSections />}
      {!q && <TodaysSpecials />}
      {!q && <SurpriseMealPromo />}

      <SearchField
        label="Search outlets and dishes"
        placeholder="Search outlets or dishes — try “chai” or “roll”"
        value={search}
        onChange={setSearch}
        className="mb-6 max-w-xl"
      />

      {outlets.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-60 rounded-(--radius-panel)" />
          ))}
        </div>
      ) : outlets.error ? (
        <ErrorState
          title="Couldn’t load outlets"
          error={outlets.error}
          onRetry={() => void outlets.refetch()}
          retrying={outlets.isFetching}
        />
      ) : outlets.data.length === 0 ? (
        q ? (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title={`Nothing matches “${q}”`}
            description="Try a different dish or outlet name."
            action={
              <Button variant="secondary" onClick={() => setSearch('')}>
                Show all outlets
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<Store aria-hidden />}
            title="No outlets yet"
            description="Campus outlets will appear here once an administrator adds them."
          />
        )
      ) : (
        <ul
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Outlets"
          aria-busy={outlets.isFetching}
        >
          {outlets.data.map((outlet) => (
            <li key={outlet.id} className="flex">
              <div className="flex w-full flex-col [&>a]:flex-1">
                <OutletCard outlet={outlet} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
