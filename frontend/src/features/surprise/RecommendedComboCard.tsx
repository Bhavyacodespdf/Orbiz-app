import { Info, RefreshCw, Sparkles, Store } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Price } from '@/components/ui/Price';
import { DishThumb } from '@/features/specials/DishThumb';
import { cn } from '@/lib/cn';
import { RatingInline } from '@/features/reviews/Stars';
import type { Combo, ComboItem } from '@/services/surprise';
import { rupees } from './surprise-labels';

function ComboItemRow({
  item,
  outletName,
  swapping,
  swapDisabled,
  message,
  onSwap,
}: {
  item: ComboItem;
  outletName: string;
  swapping: boolean;
  swapDisabled: boolean;
  message: string | null;
  onSwap: () => void;
}) {
  return (
    <li className="border-b border-dashed border-espresso-100 py-3 last:border-b-0">
      <div className={cn('flex items-center gap-3', swapping && 'opacity-60')}>
        <DishThumb imageUrl={item.imageUrl} className="size-14" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-semibold">
            {item.dietary && <DietaryMark dietary={item.dietary} />}
            <span className="truncate">{item.name}</span>
          </p>
          <p className="truncate text-sm text-espresso-500">
            {outletName} · {item.category.name}
          </p>
          <RatingInline rating={item.rating} className="text-xs" />
        </div>
        <Price paise={item.pricePaise} className="shrink-0" />
        <Button
          variant="secondary"
          size="sm"
          onClick={onSwap}
          loading={swapping}
          disabled={swapDisabled}
          aria-label={`Swap ${item.name}`}
          icon={<RefreshCw className="size-3.5" aria-hidden />}
        >
          Swap
        </Button>
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm text-espresso-700">
          {message}
        </p>
      )}
    </li>
  );
}

/** What the menu data can honestly support: no calorie, protein or prep-time totals today. */
function ComboNutritionSummary({ combo }: { combo: Combo }) {
  return (
    <p className="flex items-start gap-2 rounded-(--radius-control) bg-cream-200 px-3 py-2 text-xs text-espresso-700">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {combo.nutrition.note}
    </p>
  );
}

export function RecommendedComboCard({
  combo,
  swappingId,
  swapMessages,
  onSwap,
}: {
  combo: Combo;
  swappingId: string | null;
  swapMessages: Record<string, string>;
  onSwap: (itemId: string) => void;
}) {
  return (
    <section
      aria-labelledby="combo-heading"
      className="overflow-hidden rounded-(--radius-panel) border border-espresso-100 bg-cream-50 shadow-lift"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 bg-espresso-900 p-4 text-cream-100">
        <div>
          <h2
            id="combo-heading"
            className="flex items-center gap-1.5 text-xs font-bold tracking-[0.14em] text-mustard-300 uppercase"
          >
            <Sparkles className="size-3.5" aria-hidden />
            {combo.source === 'AI' ? 'AI recommended combo' : 'Recommended combo'}
          </h2>
          <p className="mt-1 font-display text-4xl font-extrabold tabular">
            {rupees(combo.totalPaise)}
          </p>
          <p className="text-sm text-cream-100/80">
            {combo.remainingPaise > 0
              ? `${rupees(combo.remainingPaise)} under your ${rupees(combo.budgetPaise)} budget`
              : 'Budget fully used'}
          </p>
        </div>
        <Badge tone="mustard">
          {combo.itemCount} {combo.itemCount === 1 ? 'dish' : 'dishes'}
        </Badge>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-espresso-700">
          <Store className="size-4" aria-hidden />
          From {combo.outlet.name}
        </p>
        <ul aria-label="Dishes in this combo">
          {combo.items.map((item) => (
            <ComboItemRow
              key={item.id}
              item={item}
              outletName={combo.outlet.name}
              swapping={swappingId === item.id}
              swapDisabled={swappingId !== null}
              message={swapMessages[item.id] ?? null}
              onSwap={() => onSwap(item.id)}
            />
          ))}
        </ul>
        <ul className="flex flex-col gap-1 text-sm text-espresso-700" aria-label="Why this combo">
          {combo.reasons.map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
        <ComboNutritionSummary combo={combo} />
        <p className="text-xs text-espresso-500">
          {combo.source === 'AI'
            ? 'Suggested by an AI model, then checked against the live menu, prices and your filters.'
            : 'Picked by Orbiz’s recommendation rules from the live menu (no AI model is connected).'}
        </p>
      </div>
    </section>
  );
}
