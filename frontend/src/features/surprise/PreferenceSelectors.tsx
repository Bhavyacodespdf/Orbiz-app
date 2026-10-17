import { useId } from 'react';
import { cn } from '@/lib/cn';
import { SelectField } from '@/components/ui/SelectField';
import { useOutlets } from '@/services/outlets';
import type { Diet, Mood } from '@/services/surprise';
import { DIET_LABELS, MOOD_INFO } from './surprise-labels';

const heading = 'text-sm font-bold tracking-[0.12em] text-espresso-500 uppercase';

/** One mood at a time, as a radio group styled as cards. */
export function MoodSelector({
  moods,
  value,
  onChange,
}: {
  moods: Mood[];
  value: Mood;
  onChange: (mood: Mood) => void;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className={cn(heading, 'mb-3')}>Craving mood</legend>
      <div className="grid grid-cols-2 gap-2">
        {moods.map((mood) => {
          const info = MOOD_INFO[mood];
          const Icon = info.icon;
          const selected = mood === value;
          return (
            <label
              key={mood}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-(--radius-control) border-2 p-3 transition-colors focus-within:ring-2 focus-within:ring-success-600/40',
                selected
                  ? 'border-success-600 bg-success-50'
                  : 'border-espresso-100 bg-cream-50 hover:border-espresso-200',
              )}
            >
              <input
                type="radio"
                name={`${id}-mood`}
                value={mood}
                checked={selected}
                onChange={() => onChange(mood)}
                className="sr-only"
              />
              <span
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-full',
                  selected ? 'bg-success-600 text-white' : 'bg-cream-200 text-espresso-700',
                )}
              >
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{info.label}</span>
                <span className="block text-xs text-espresso-500">{info.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Veg / Non-Veg are strict filters applied by the server from the menu's own labels. */
export function DietSelector({
  diets,
  value,
  onChange,
}: {
  diets: Diet[];
  value: Diet;
  onChange: (diet: Diet) => void;
}) {
  const id = useId();
  return (
    <fieldset>
      <legend className={cn(heading, 'mb-3')}>Diet</legend>
      <div className="inline-flex rounded-full border border-espresso-200 bg-cream-50 p-1">
        {diets.map((diet) => (
          <label
            key={diet}
            className={cn(
              'cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold focus-within:ring-2 focus-within:ring-success-600/40',
              diet === value ? 'bg-espresso-900 text-cream-100' : 'text-espresso-700',
            )}
          >
            <input
              type="radio"
              name={`${id}-diet`}
              value={diet}
              checked={diet === value}
              onChange={() => onChange(diet)}
              className="sr-only"
            />
            {DIET_LABELS[diet]}
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-espresso-500">
        Uses each dish’s menu label. Unlabelled dishes are only included under Any.
      </p>
    </fieldset>
  );
}

/** Real outlets from the server; closed ones are listed but marked. */
export function OutletSelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (outletId: string | null) => void;
}) {
  const outlets = useOutlets('');
  return (
    <SelectField
      label="Outlet"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      disabled={outlets.isPending}
    >
      <option value="">All outlets</option>
      {(outlets.data ?? []).map((outlet) => (
        <option key={outlet.id} value={outlet.id}>
          {outlet.name}
          {outlet.acceptingOrders ? '' : ' (not taking orders)'}
        </option>
      ))}
    </SelectField>
  );
}
