import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** The standard raised surface. Use sparingly — not everything needs a box. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-(--radius-panel) border border-line bg-surface-raised shadow-lift',
        className,
      )}
      {...rest}
    />
  );
}
