import { useId } from 'react';
import { cn } from '@/lib/cn';
import type { SurpriseOptions } from '@/services/surprise';
import { rupees } from './surprise-labels';

/** Budget cap: a slider plus quick picks. The server enforces the limits again. */
export function BudgetSelector({
  budget,
  valuePaise,
  onChange,
}: {
  budget: SurpriseOptions['budget'];
  valuePaise: number;
  onChange: (paise: number) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2
          id={`${id}-heading`}
          className="text-sm font-bold tracking-[0.12em] text-espresso-500 uppercase"
        >
          Budget cap
        </h2>
        <output htmlFor={`${id}-slider`} className="font-display text-3xl font-extrabold tabular">
          {rupees(valuePaise)}
        </output>
      </div>
      <input
        id={`${id}-slider`}
        type="range"
        aria-label="Maximum budget"
        aria-valuetext={rupees(valuePaise)}
        min={budget.minPaise}
        max={budget.maxPaise}
        step={budget.stepPaise}
        value={valuePaise}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-success-600"
      />
      <div className="flex justify-between text-xs text-espresso-500">
        <span>{rupees(budget.minPaise)}</span>
        <span>{rupees(budget.maxPaise)}</span>
      </div>
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        role="group"
        aria-label="Quick budgets"
      >
        {budget.presets.map((preset) => {
          const selected = preset.budgetPaise === valuePaise;
          return (
            <button
              key={preset.budgetPaise}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(preset.budgetPaise)}
              className={cn(
                'rounded-(--radius-control) border px-3 py-2 text-sm font-semibold transition-colors',
                selected
                  ? 'border-success-600 bg-success-50 text-success-700'
                  : 'border-espresso-200 bg-cream-50 hover:border-espresso-400',
              )}
            >
              {rupees(preset.budgetPaise)} {preset.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
