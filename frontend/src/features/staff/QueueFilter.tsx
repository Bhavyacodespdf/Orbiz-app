import { cn } from '@/lib/cn';
import type { QueueFilter } from '@/services/staff';

const FILTERS: { value: QueueFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'IMMEDIATE', label: 'Order now' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'UPCOMING', label: 'Upcoming' },
  { value: 'PAST_DUE', label: 'Past due' },
];

/** Narrows the live queue by when the food is wanted (filtering happens on the server). */
export function QueueFilterChips({
  value,
  onChange,
}: {
  value: QueueFilter;
  onChange: (value: QueueFilter) => void;
}) {
  return (
    <div role="group" aria-label="Order timing filter" className="flex flex-wrap gap-2">
      {FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          aria-pressed={value === f.value}
          onClick={() => onChange(f.value)}
          className={cn(
            'h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors',
            value === f.value
              ? 'border-espresso-900 bg-espresso-900 text-cream-100'
              : 'border-espresso-200 bg-cream-50 hover:border-espresso-400',
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
