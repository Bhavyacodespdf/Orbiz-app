import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Gift, ShoppingBag, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { newIdempotencyKey } from '@/lib/idempotency';
import { ApiError } from '@/services/http';
import {
  useAddComboToCart,
  useGenerateCombo,
  useSurpriseOptions,
  useSwapComboItem,
  type GenerateResult,
  type Preferences,
  type SurpriseOptions,
} from '@/services/surprise';
import { BudgetSelector } from './BudgetSelector';
import { DietSelector, MoodSelector, OutletSelector } from './PreferenceSelectors';
import { RecommendedComboCard } from './RecommendedComboCard';
import { rupees } from './surprise-labels';

/** Wait this long after the last change before asking for a new combo (slider drags). */
const REGENERATE_DELAY_MS = 350;

function Solver({ options }: { options: SurpriseOptions }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Preferences>({
    budgetPaise: options.budget.presets[1]?.budgetPaise ?? options.budget.minPaise,
    mood: 'QUICK_BITE',
    diet: 'ANY',
    outletId: null,
  });
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [swapMessages, setSwapMessages] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  // The inline confirmation (with its "View tray" link) — no toast, which would cover it.
  const [added, setAdded] = useState<{ outlet: string; isNew: boolean } | null>(null);

  const generate = useGenerateCombo();
  const swap = useSwapComboItem();
  const addToCart = useAddComboToCart();

  // Only the newest request may update the screen (preferences can change mid-flight).
  const latestRequest = useRef(0);
  // One key per combo shown: adding the same combo twice can never add it twice.
  const comboKey = useRef(newIdempotencyKey());

  const showResult = useCallback((next: GenerateResult) => {
    comboKey.current = newIdempotencyKey();
    setResult(next);
    setSwapMessages({});
    setAdded(null);
  }, []);

  const requestCombo = generate.mutate; // stable across renders
  const run = useCallback(
    (current: Preferences, avoidItemIds: string[]) => {
      const request = ++latestRequest.current;
      setNotice(null);
      requestCombo(
        { ...current, avoidItemIds },
        {
          onSuccess: (next) => {
            if (request === latestRequest.current) showResult(next);
          },
        },
      );
    },
    [requestCombo, showResult],
  );

  // New preferences → a new combo (debounced so dragging the slider sends one request).
  useEffect(() => {
    const timer = window.setTimeout(() => run(prefs, []), REGENERATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [prefs, run]);

  const combo = result?.combo ?? null;
  // Re-selecting the current choice changes nothing, so it mustn't start a new combo either.
  const update = (patch: Partial<Preferences>) =>
    setPrefs((p) =>
      (Object.keys(patch) as (keyof Preferences)[]).every((k) => Object.is(p[k], patch[k]))
        ? p
        : { ...p, ...patch },
    );

  function respin() {
    if (generate.isPending) return;
    run(prefs, combo ? combo.items.map((i) => i.id) : []);
  }

  function swapItem(itemId: string) {
    if (!combo || swap.isPending) return;
    const request = latestRequest.current;
    swap.mutate(
      { ...prefs, itemIds: combo.items.map((i) => i.id), replaceItemId: itemId },
      {
        onSuccess: (next) => {
          if (request !== latestRequest.current) return; // a newer combo replaced this one
          if (next.swapped) {
            comboKey.current = newIdempotencyKey();
            setResult((r) => r && { ...r, combo: next.combo });
            setSwapMessages({});
            setAdded(null);
          } else {
            setSwapMessages((m) => ({ ...m, [itemId]: next.message }));
          }
        },
        onError: (error) => {
          const outOfDate = error instanceof ApiError && error.code === 'COMBO_OUT_OF_DATE';
          setSwapMessages((m) => ({
            ...m,
            [itemId]: outOfDate ? error.message : `Couldn’t swap: ${describeError(error)}`,
          }));
        },
      },
    );
  }

  function addCombo(replaceCart: boolean) {
    if (!combo || addToCart.isPending) return;
    addToCart.mutate(
      { combo, replaceCart, idempotencyKey: comboKey.current },
      {
        onSuccess: ({ added: isNew }) => {
          setConflict(null);
          setAdded({ outlet: combo.outlet.name, isNew });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'CART_OUTLET_CONFLICT') {
            const current = (error.details as { currentOutlet?: { name: string } } | undefined)
              ?.currentOutlet?.name;
            setConflict(current ?? 'another outlet');
            return;
          }
          setConflict(null);
          if (
            error instanceof ApiError &&
            ['PRICE_CHANGED', 'ITEMS_UNAVAILABLE', 'OUTLET_NOT_ACCEPTING'].includes(error.code)
          ) {
            setNotice(`${error.message} Re-spin for an up-to-date combo.`);
            return;
          }
          toast.show({
            tone: 'error',
            title: 'Couldn’t add the combo',
            description: describeError(error),
          });
        },
      },
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <Panel className="flex h-fit flex-col gap-6 p-4 sm:p-5">
        <BudgetSelector
          budget={options.budget}
          valuePaise={prefs.budgetPaise}
          onChange={(budgetPaise) => update({ budgetPaise })}
        />
        <MoodSelector
          moods={options.moods}
          value={prefs.mood}
          onChange={(mood) => update({ mood })}
        />
        <DietSelector
          diets={options.diets}
          value={prefs.diet}
          onChange={(diet) => update({ diet })}
        />
        <OutletSelector value={prefs.outletId} onChange={(outletId) => update({ outletId })} />
        <p className="text-xs text-espresso-500">
          A tray holds dishes from one outlet, so each combo comes from a single outlet.
        </p>
      </Panel>

      <div className="flex flex-col gap-4">
        <Button
          size="lg"
          block
          onClick={respin}
          loading={generate.isPending}
          className="bg-success-600 hover:bg-success-700"
          icon={<Sparkles className="size-5" aria-hidden />}
        >
          Re-spin Surprise Combo
        </Button>

        {result?.notices.map((text) => (
          <p
            key={text}
            className="rounded-(--radius-control) bg-mustard-50 px-3 py-2 text-sm text-mustard-800"
          >
            {text}
          </p>
        ))}
        {notice && (
          <p
            role="alert"
            className="rounded-(--radius-control) bg-chili-50 px-3 py-2 text-sm text-chili-700"
          >
            {notice}
          </p>
        )}

        {generate.isError && !result ? (
          <ErrorState
            title="Couldn’t make a combo"
            error={generate.error}
            onRetry={() => run(prefs, [])}
            retrying={generate.isPending}
          />
        ) : !result ? (
          <div aria-busy className="flex flex-col gap-3">
            <Skeleton className="h-28 w-full rounded-(--radius-panel)" />
            <Skeleton className="h-48 w-full rounded-(--radius-panel)" />
          </div>
        ) : !combo ? (
          <EmptyState
            icon={<Gift aria-hidden />}
            title="No combo fits these choices"
            description={result.reason?.message ?? 'Try a bigger budget or another filter.'}
          />
        ) : (
          <div aria-busy={generate.isPending} className={generate.isPending ? 'opacity-70' : ''}>
            <RecommendedComboCard
              combo={combo}
              swappingId={swap.isPending ? (swap.variables?.replaceItemId ?? null) : null}
              swapMessages={swapMessages}
              onSwap={swapItem}
            />
          </div>
        )}

        {combo && (
          <>
            <Button
              size="lg"
              block
              onClick={() => addCombo(false)}
              loading={addToCart.isPending}
              disabled={generate.isPending || swap.isPending}
              className="bg-plum-600 hover:bg-plum-700"
              icon={<ShoppingBag className="size-5" aria-hidden />}
            >
              Add Combo to Tray · {rupees(combo.totalPaise)}
            </Button>
            {added && (
              <p
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-control) bg-success-50 px-3 py-2 text-sm text-success-700"
              >
                {added.isNew
                  ? `Combo added to your tray from ${added.outlet}.`
                  : `This combo is already in your tray (${added.outlet}).`}
                <ButtonLink to="/cart" size="sm" variant="secondary">
                  View tray
                </ButtonLink>
              </p>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={conflict !== null}
        title="Start a new tray?"
        description={`Your tray has dishes from ${conflict}. A tray holds one outlet at a time, so adding this combo will replace them.`}
        confirmLabel="Replace tray"
        cancelLabel="Keep my tray"
        loading={addToCart.isPending}
        onConfirm={() => addCombo(true)}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}

export function SurpriseMealPage() {
  const options = useSurpriseOptions();
  return (
    <>
      <header className="mb-6 flex items-start gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-(--radius-control) bg-mustard-50 text-mustard-700">
          <Gift className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold md:text-3xl">AI Surprise Meal</h1>
            <Badge tone="dark">Budget solver</Badge>
          </div>
          <p className="mt-1 text-espresso-700">100% budget-guaranteed campus culinary combos</p>
        </div>
        <Link
          to="/"
          aria-label="Close Surprise Meal"
          className="grid size-10 shrink-0 place-items-center rounded-full text-espresso-700 hover:bg-espresso-50"
        >
          <X className="size-5" aria-hidden />
        </Link>
      </header>

      {options.isPending ? (
        <Skeleton className="h-96 w-full rounded-(--radius-panel)" />
      ) : options.error ? (
        <ErrorState
          title="Couldn’t load Surprise Meal"
          error={options.error}
          onRetry={() => void options.refetch()}
          retrying={options.isFetching}
        />
      ) : (
        <Solver options={options.data} />
      )}
    </>
  );
}
