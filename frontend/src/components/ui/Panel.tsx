import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** The standard raised surface. Use sparingly — not everything needs a box. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-(--radius-panel) border border-espresso-100 bg-cream-50 shadow-lift',
        className,
      )}
      {...rest}
    />
  );
}
