import type { ReactNode } from 'react';
import { ArrowDownWideNarrow } from 'lucide-react';
import { MENU_SORTS, type MenuSort } from '@/services/outlets';
import { chipClass } from './menu-labels';

/**
 * The five sort options as pills that wrap on small screens (no sideways scrolling). The chosen
 * one is highlighted; choosing it again goes back to the outlet's own order.
 */
export function SortChips({
  value,
  onChange,
}: {
  value: MenuSort | undefined;
  onChange: (sort: MenuSort | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p
        id="menu-sort-label"
        className="flex items-center gap-1.5 text-sm font-semibold text-espresso-700"
      >
        <ArrowDownWideNarrow className="size-4" aria-hidden />
        Sort by
      </p>
      <div role="group" aria-labelledby="menu-sort-label" className="flex flex-wrap gap-2">
        {MENU_SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={value === s.value}
            className={chipClass(value === s.value)}
            onClick={() => onChange(value === s.value ? undefined : s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A note above the results explaining what a sort is based on (and when it can't apply). */
export function SortNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-(--radius-control) bg-cream-200 px-3 py-2 text-sm text-espresso-700"
    >
      {children}
    </p>
  );
}
