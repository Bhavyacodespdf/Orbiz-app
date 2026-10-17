import { cn } from '@/lib/cn';
import { MENU_SORTS, type MenuSort } from '@/services/outlets';

/** The pill style used by every menu filter. */
export const chipClass = (active: boolean) =>
  cn(
    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors',
    active
      ? 'border-espresso-900 bg-espresso-900 text-cream-100'
      : 'border-espresso-200 bg-cream-50 text-espresso-700 hover:border-espresso-400',
  );

export const sortLabel = (sort: MenuSort) => MENU_SORTS.find((s) => s.value === sort)!.label;
