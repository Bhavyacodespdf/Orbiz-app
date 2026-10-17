import { cn } from '@/lib/cn';

/** Grey placeholder block shown while real data loads. Never filled with fake content. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-(--radius-control) bg-espresso-100/70', className)}
    />
  );
}
