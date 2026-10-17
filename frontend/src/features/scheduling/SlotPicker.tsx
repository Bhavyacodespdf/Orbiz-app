import { useId, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { SelectField } from '@/components/ui/SelectField';
import { cn } from '@/lib/cn';
import type { SlotOptions } from '@/services/scheduling';
import { formatDayChoice, formatSlot } from './schedule-format';

/**
 * Pick a day, then one of its pickup slots. Only slots the server offered are shown;
 * full ones are listed but can't be chosen.
 */
export function SlotPicker({
  options,
  value,
  onChange,
  nowMs,
}: {
  options: SlotOptions;
  value: string | null;
  onChange: (startsAt: string | null) => void;
  nowMs: number;
}) {
  const id = useId();
  const days = options.days.filter((d) => d.slots.length > 0);
  const valueDay = value
    ? days.find((d) => d.slots.some((s) => s.startsAt === value))?.date
    : undefined;
  const [chosenDay, setChosenDay] = useState<string | undefined>(valueDay ?? days[0]?.date);
  const day = days.find((d) => d.date === (valueDay ?? chosenDay)) ?? days[0];

  if (!day) {
    return (
      <p
        role="status"
        className="rounded-(--radius-control) bg-cream-200 px-3 py-2 text-sm text-espresso-700"
      >
        There are no pickup slots left to book at this outlet right now. You can order now instead,
        or try again later.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Pickup day" className="flex flex-wrap gap-2">
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            aria-pressed={d.date === day.date}
            onClick={() => {
              setChosenDay(d.date);
              if (d.date !== day.date) onChange(null);
            }}
            className={cn(
              'h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors',
              d.date === day.date
                ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                : 'border-espresso-200 bg-cream-50 hover:border-espresso-400',
            )}
          >
            {formatDayChoice(d.date, nowMs)}
          </button>
        ))}
      </div>
      <SelectField
        label="Pickup time"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Choose a time</option>
        {day.slots.map((slot) => (
          <option key={slot.startsAt} value={slot.startsAt} disabled={!slot.available}>
            {slot.label}
            {slot.available ? '' : ' (full)'}
          </option>
        ))}
      </SelectField>
      {value && (
        <p
          id={`${id}-chosen`}
          className="flex items-center gap-2 rounded-(--radius-control) bg-success-50 px-3 py-2 text-sm font-semibold text-success-700"
        >
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          Pickup: {formatSlot(value)} (IST)
        </p>
      )}
    </div>
  );
}
