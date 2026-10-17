import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Badge, type BadgeTone } from '@/components/ui/Badge';

export function PersonAvatar({
  name,
  url,
  className,
}: {
  name: string;
  url?: string | null;
  className?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return url ? (
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      className={cn('size-9 shrink-0 rounded-full object-cover', className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full bg-mustard-500 font-display font-bold text-espresso-900',
        className,
      )}
    >
      {initial}
    </span>
  );
}

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>;
}

/** Card used across the three tabs. */
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-(--radius-panel) border border-espresso-100 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] md:p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
