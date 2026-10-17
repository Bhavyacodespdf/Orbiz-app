import { cn } from '@/lib/cn';

export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type Size = 'sm' | 'md' | 'lg';

const base =
  'inline-flex select-none items-center justify-center gap-2 rounded-(--radius-control) font-semibold transition-[background-color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

const variants: Record<Variant, string> = {
  primary: 'bg-chili-500 text-white shadow-press hover:bg-chili-600',
  secondary:
    'border border-espresso-200 bg-cream-50 text-espresso-900 shadow-press hover:border-espresso-400 hover:bg-white',
  ghost: 'text-espresso-700 hover:bg-espresso-50',
  danger: 'border border-chili-200 bg-chili-50 text-chili-700 hover:bg-chili-100',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-[0.95rem]',
  lg: 'h-13 px-6 text-base',
};

export function buttonClasses({
  variant = 'primary',
  size = 'md',
  block = false,
}: { variant?: Variant; size?: Size; block?: boolean } = {}) {
  return cn(base, variants[variant], sizes[size], block && 'w-full');
}
