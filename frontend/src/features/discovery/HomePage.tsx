import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SearchX, Store } from 'lucide-react';
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

  // keepPreviousData holds the last results while a new search runs. Without this guard the
  // old empty result would claim "nothing matches" before the server has answered the new one.
  const searching = outlets.isPending || (outlets.isFetching && outlets.data?.length === 0);

  return (
    <div className="space-y-10 md:space-y-14">
      <section className="grain animate-rise relative overflow-hidden rounded-[1.75rem] bg-espresso-900 px-6 pt-12 pb-20 sm:px-10 sm:pt-14 sm:pb-24">
        {/* Two warm lamps and a paper grain, so the dark panel has depth instead of flatness. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 -right-20 size-[30rem] rounded-full bg-mustard-500/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-48 -left-32 size-[30rem] rounded-full bg-chili-500/25 blur-3xl"
        />
        <span
          aria-hidden
          className="grain-layer pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
        />

        <div className="relative grid gap-10 lg:grid-cols-[1.45fr_1fr] lg:items-center lg:gap-12">
          <div>
            <p className="flex items-center gap-3 text-[0.72rem] font-bold tracking-[0.24em] text-mustard-300 uppercase">
              <span aria-hidden className="h-px w-10 bg-mustard-500/60" />
              Campus outlets
            </p>
            <h1 className="mt-5 font-display text-[2.75rem] leading-[0.98] font-extrabold tracking-[-0.035em] text-balance text-cream-100 sm:text-[4.25rem]">
              Hungry? Let’s get you fed.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-relaxed text-pretty text-cream-100/70 sm:text-lg">
              Browse what’s cooking across campus, order ahead, and pick up when it’s ready.
            </p>
          </div>

          {!q && <SurpriseMealPromo />}
        </div>
      </section>

      {/* Lifted out of the hero so it reads as the first thing you act on. */}
      <div className="relative z-10 -mt-12 px-4 sm:px-10">
        <SearchField
          label="Search outlets and dishes"
          placeholder="Search outlets or dishes — try “chai” or “roll”"
          value={search}
          onChange={setSearch}
          className="h-14 max-w-2xl border-transparent shadow-float"
        />
      </div>

      {!q && <ReorderSections />}
      {!q && <TodaysSpecials />}

      {searching ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="animate-shimmer overflow-hidden rounded-2xl border border-line bg-surface-raised"
              style={{ animationDelay: `${n * 140}ms` }}
            >
              <Skeleton className="h-36 rounded-none" />
              <div className="space-y-3 p-5">
                <Skeleton className="h-6 w-2/3 rounded-md" />
                <Skeleton className="h-4 w-1/2 rounded-md" />
                <Skeleton className="h-4 w-full rounded-md" />
              </div>
            </div>
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
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Outlets"
          aria-busy={outlets.isFetching}
        >
          {outlets.data.map((outlet, index) => (
            <li key={outlet.id} className="flex">
              <OutletCard outlet={outlet} index={index} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
