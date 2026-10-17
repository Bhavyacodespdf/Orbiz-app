import { Link } from 'react-router';
import { Sparkles, Vote } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Panel } from '@/components/ui/Panel';
import { Price } from '@/components/ui/Price';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { AddToCartControl } from '@/features/cart/AddToCartControl';
import type { Outlet } from '@/services/outlets';
import { useOutletSpecial, useTodaysSpecials, type Special } from '@/services/polls';
import { DishThumb } from './DishThumb';
import { outcomeSummary } from './poll-format';

const summaryOf = (s: Special) =>
  outcomeSummary(s.outcome, s.winnerVotes, s.totalVotes, s.winnerPercentage);

function SpecialEyebrow() {
  return (
    <Badge tone="mustard" icon={<Sparkles className="size-3.5" aria-hidden />}>
      Today’s Special
    </Badge>
  );
}

/**
 * Home page strip: every outlet's Today's Special, decided by student votes.
 * Nothing is shown when no outlet has a special today, or if specials can't be
 * loaded — they are a bonus and must never block browsing outlets.
 */
export function TodaysSpecials() {
  const specials = useTodaysSpecials();
  const list = specials.data?.specials ?? [];
  if (list.length === 0) return null;

  return (
    <section aria-labelledby="todays-specials" className="mb-8">
      <h2 id="todays-specials" className="mb-3 flex items-center gap-2 text-xl font-extrabold">
        <Sparkles className="size-5 text-mustard-600" aria-hidden />
        Today’s specials
      </h2>
      <ul className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2">
        {list.map((s) => (
          <li key={s.pollId} className="w-72 shrink-0 snap-start sm:w-80">
            <Link
              to={`/outlets/${s.outlet.slug}`}
              className="flex h-full gap-3 rounded-(--radius-panel) border border-mustard-100 bg-mustard-50 p-3 transition-shadow hover:shadow-lift"
              aria-label={`${s.dish.name}, today’s special at ${s.outlet.name}`}
            >
              <DishThumb imageUrl={s.dish.imageUrl} className="size-20" />
              <div className="flex min-w-0 flex-col gap-1">
                <SpecialEyebrow />
                <p className="truncate font-bold text-espresso-900">{s.dish.name}</p>
                <p className="truncate text-sm text-espresso-700">{s.outlet.name}</p>
                <div className="flex items-center gap-2 text-sm">
                  <Price paise={s.dish.pricePaise} />
                  {!s.dish.orderable && <Badge tone="neutral">Not available now</Badge>}
                </div>
                <p className="text-xs text-espresso-500">{summaryOf(s)}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The outlet page banner for this outlet's Today's Special, if it has one. */
export function OutletSpecial({ outlet }: { outlet: Outlet }) {
  const special = useOutletSpecial(outlet.slug).data?.special;
  if (!special) return null;
  const { dish } = special;

  return (
    <Panel
      className="mb-6 flex flex-col gap-4 border-mustard-100 bg-mustard-50 p-4 sm:flex-row sm:items-center"
      aria-labelledby="outlet-special"
      role="region"
    >
      <DishThumb imageUrl={dish.imageUrl} className="h-40 w-full sm:size-28" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <SpecialEyebrow />
        <h2 className="flex items-center gap-2 text-2xl font-extrabold">
          {dish.dietary && <DietaryMark dietary={dish.dietary} />}
          <span id="outlet-special">{dish.name}</span>
        </h2>
        {dish.description && <p className="text-espresso-700">{dish.description}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-espresso-700">
          <Price paise={dish.pricePaise} className="text-base text-espresso-900" />
          <span>{dish.category.name}</span>
          <span className="inline-flex items-center gap-1">
            <Vote className="size-4" aria-hidden />
            {summaryOf(special)}
          </span>
        </p>
        {!dish.orderable && (
          <Badge tone="neutral" className="w-fit">
            Not available to order right now
          </Badge>
        )}
      </div>
      <div className="shrink-0">
        <AddToCartControl
          outlet={outlet}
          item={{
            id: dish.id,
            categoryId: dish.category.id,
            name: dish.name,
            description: dish.description,
            pricePaise: dish.pricePaise,
            dietary: dish.dietary,
            isAvailable: dish.orderable,
            stockStatus: dish.stockStatus,
            imageUrl: dish.imageUrl,
          }}
        />
      </div>
    </Panel>
  );
}
